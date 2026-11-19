// Pinning tests for contracts other packages and production files depend on.
// Change them only on purpose:
//   - the TsLive token file: a different path or field name turns every TsLive
//     playlist request into a 401 loop;
//   - list line formats and the recording identity: they decide which streamer a
//     folder belongs to and which list line a target is written as;
//   - the active destination's limits.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// readTokens fixes its path from the home directory when it is imported, so
// point HOME at a temporary directory first. The data-root variable is set to a
// different directory to show the token path does not follow it.
const home = await mkdtemp(path.join(os.tmpdir(), "pins-shared-home-"));
const otherDataRoot = await mkdtemp(path.join(os.tmpdir(), "pins-shared-data-"));
process.env.HOME = home;
process.env.VIDEO_SERVICES_DATA_ROOT = otherDataRoot;
const {
    readTokens,
    formatStreamerTarget,
    streamerSourceLinks,
    targetMembershipIdentifiers,
    extractRecordingIdentifier,
    PROVIDER_UPLOAD_POLICIES,
    UPLOAD_PROVIDER_PLAN,
    policyForUploadProvider,
} = await import("../dist/index.js");
test.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(otherDataRoot, { recursive: true, force: true });
});

// The session file name is the auth account's e-mail plus ".json". It is pinned
// by hash so this public test does not repeat the address.
const SESSION_FILE_NAME_SHA256 = "8c732ee6f643fe1b2ac1455bed6e833545595d6711265e9709417f99af594e0d";

async function sessionFilePath(t) {
    const requested = [];
    const readFile = fsPromises.readFile;
    t.mock.method(fsPromises, "readFile", async (file, ...rest) => {
        requested.push(String(file));
        return await readFile.call(fsPromises, file, ...rest);
    });
    await readTokens();
    t.mock.restoreAll();
    assert.equal(requested.length, 1, "readTokens reads exactly one file");
    return requested[0];
}

test("pin: readTokens reads ~/.local/share/video-services/session/<account>.json, not the data root", async (t) => {
    const file = await sessionFilePath(t);
    assert.equal(path.dirname(file), path.join(home, ".local", "share", "video-services", "session"));
    assert.equal(createHash("sha256").update(path.basename(file)).digest("hex"), SESSION_FILE_NAME_SHA256,
        "the session file name changed; auth writes session/<e-mail>.json");
    assert(!file.startsWith(otherDataRoot), "VIDEO_SERVICES_DATA_ROOT does not move the token file");
});

test("pin: readTokens field mapping (tsliveST, tt, ttu, tte, lastWriteMs)", async (t) => {
    const file = await sessionFilePath(t);
    await mkdir(path.dirname(file), { recursive: true });
    const now = 1_800_000_000_123;
    t.mock.method(Date, "now", () => now);
    const write = (session) => writeFile(file, JSON.stringify(session));
    await write({
        tsliveRT: "synthetic-refresh", tsliveST: "synthetic-st", tt: "synthetic-tt", ttu: "synthetic-ttu",
        tte: String(1_800_000_600), lastWriteMs: now - 4_000, browserState: "ignored",
    });
    assert.deepEqual(await readTokens(), {
        st: "synthetic-st", tt: "synthetic-tt", ttu: "synthetic-ttu", tte: "1800000600",
        readAtMs: now, ttlAtReadSec: 600, tokenAgeMs: 4_000,
    });
    const empty = { st: null, tt: null, ttu: null, tte: null, readAtMs: now, ttlAtReadSec: null, tokenAgeMs: null };
    // Without the session token nothing is used, even the stream tokens.
    await write({ tt: "synthetic-tt", ttu: "synthetic-ttu", tte: "1800000600" });
    assert.deepEqual(await readTokens(), empty);
    // Other spellings of the session token are not read.
    await write({ st: "synthetic-st", "TsLive-ST": "synthetic-st", tt: "synthetic-tt" });
    assert.deepEqual(await readTokens(), empty);
    await write({ tsliveST: "synthetic-st" });
    assert.deepEqual(await readTokens(), { ...empty, st: "synthetic-st" });
    await write({ tsliveST: "synthetic-st", tte: "not-a-number" });
    assert.deepEqual(await readTokens(), { ...empty, st: "synthetic-st", tte: "not-a-number" });
    await writeFile(file, "{ torn");
    assert.deepEqual(await readTokens(), empty);
    await rm(file);
    assert.deepEqual(await readTokens(), empty);
});

test("pin: download-list line format and source links per site", () => {
    const tslive = { provider: "tslive", id: "acct123", label: "synthetic_alias" };
    const ladder = { provider: "ladder", id: "10000001", label: "10000001" };
    const fmp4 = { provider: "fmp4", id: "20000002", label: "synthetic_room" };
    assert.equal(formatStreamerTarget(tslive), "https://ts-live.example/acct123 synthetic_alias");
    assert.equal(formatStreamerTarget(ladder), "https://ladder-live.example/10000001/");
    assert.equal(formatStreamerTarget(fmp4), "https://fmp4-live.example/synthetic_room 20000002");
    assert.deepEqual(streamerSourceLinks(tslive), {
        streamerUrl: "https://ts-live.example/acct123", aliasUrl: "https://ts-live.example/synthetic_alias" });
    assert.deepEqual(streamerSourceLinks({ ...tslive, label: "acct123" }), { streamerUrl: "https://ts-live.example/acct123", aliasUrl: null });
    assert.deepEqual(streamerSourceLinks(ladder), { streamerUrl: "https://ladder-live.example/10000001/", aliasUrl: null });
    assert.deepEqual(streamerSourceLinks(fmp4), {
        streamerUrl: "https://fmp4-live.example/20000002", aliasUrl: "https://fmp4-live.example/synthetic_room" });
    assert.deepEqual(targetMembershipIdentifiers(fmp4, [" old_room ", "synthetic_room", ""]),
        ["20000002", "synthetic_room", "old_room"]);
});

test("pin: the recording identity is everything after the folder's date and time", () => {
    assert.equal(extractRecordingIdentifier("2026-03-04 050607 synthetic_alias"), "synthetic_alias");
    assert.equal(extractRecordingIdentifier("2026-03-04 050607 10000001"), "10000001");
    assert.equal(extractRecordingIdentifier("2026-03-04 050607 alias with spaces"), "alias with spaces");
    assert.equal(extractRecordingIdentifier("  2026-03-04   050607\tspaced\tout  "), "spaced out");
    // Fewer than three words: the whole trimmed name.
    assert.equal(extractRecordingIdentifier(" synthetic_alias "), "synthetic_alias");
    assert.equal(extractRecordingIdentifier("two words"), "two words");
    // The first two words are dropped whatever they are.
    assert.equal(extractRecordingIdentifier("not a timestamp"), "timestamp");
});

test("pin: the active destination's limits", () => {
    assert.equal(UPLOAD_PROVIDER_PLAN.primary, "videohost");
    const { evidence, ...videohost } = PROVIDER_UPLOAD_POLICIES.videohost;
    assert.deepEqual(videohost, {
        provider: "videohost",
        uploadVisibility: "public",
        minimumDurationSeconds: 120,
        maximumDurationSeconds: null,
        maximumFileBytes: 10_000_000_000,
        inactiveDeletionDays: null,
        maintenanceVisitIntervalDays: null,
        unresolvedConstraints: ["acceptedContainersAndCodecsBeyondH264AacMp4"],
    });
    assert.equal(evidence.length, 3);
    // What the pipeline's upload and shorts code reads.
    assert.deepEqual(policyForUploadProvider("videohost"), {
        providers: ["videohost"],
        minimumDurationSeconds: 120,
        maximumDurationSeconds: null,
        maximumFileBytes: 10_000_000_000,
        unresolvedConstraints: ["videohost.acceptedContainersAndCodecsBeyondH264AacMp4"],
    });
});
