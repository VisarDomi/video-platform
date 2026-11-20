// Pinning tests for contracts other packages and production files depend on.
// Change them only on purpose:
//   - the session files of the core's credential store (session/<account>.json): a
//     different path turns every playlist request of a signed-in site into a 401 loop (the account
//     is the sites file's; a site's own field mapping is pinned with its plug-in);
//   - the recording identity: it decides which streamer a folder belongs to (the
//     list line formats and source links moved with the site catalogs: they are
//     pinned in private/test/pinsListsAndTokens.test.mjs, the pipeline's copy of the
//     source links in pipeline/test/sourceLinks.test.mjs, and
//     targetMembershipIdentifiers in sdk/test/toolkit.test.mjs).
import assert from "node:assert/strict";
import { promises as fsPromises } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The store takes its directory from the home directory, so point HOME at a
// temporary directory first. The data-root variable is set to a different
// directory to show the session path does not follow it.
const home = await mkdtemp(path.join(os.tmpdir(), "pins-shared-home-"));
const otherDataRoot = await mkdtemp(path.join(os.tmpdir(), "pins-shared-data-"));
process.env.HOME = home;
process.env.VIDEO_SERVICES_DATA_ROOT = otherDataRoot;
const {
    CredentialStore,
    extractRecordingIdentifier,
} = await import("../dist/index.js");
test.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(otherDataRoot, { recursive: true, force: true });
});

// The session file name is the account's e-mail plus ".json"; this one is synthetic.
const ACCOUNT = "fixture@example.invalid";

async function sessionFilePath(t, store = new CredentialStore()) {
    const requested = [];
    const readFile = fsPromises.readFile;
    t.mock.method(fsPromises, "readFile", async (file, ...rest) => {
        requested.push(String(file));
        return await readFile.call(fsPromises, file, ...rest);
    });
    await store.read(ACCOUNT);
    t.mock.restoreAll();
    assert.equal(requested.length, 1, "a read reads exactly one file");
    return requested[0];
}

// Moved from the readTokens pin (shared's reader went; the core's store is the one reader).
test("pin: the credential store reads ~/.local/share/video-services/session/<account>.json, not the data root", async (t) => {
    const file = await sessionFilePath(t);
    assert.equal(path.dirname(file), path.join(home, ".local", "share", "video-services", "session"));
    assert.equal(path.basename(file), `${ACCOUNT}.json`, "auth writes session/<e-mail>.json");
    assert(!file.startsWith(otherDataRoot), "VIDEO_SERVICES_DATA_ROOT does not move the session file");
});

test("pin: the store reads what auth saves, with lastWriteMs, and nothing from a torn or missing file", async (t) => {
    const store = new CredentialStore();
    const file = await sessionFilePath(t, store);
    await mkdir(path.dirname(file), { recursive: true });
    const now = 1_800_000_000_123;
    t.mock.method(Date, "now", () => now);
    await store.write(ACCOUNT, { accessRT: "synthetic-refresh", accessST: "synthetic-st" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { accessRT: "synthetic-refresh", accessST: "synthetic-st", lastWriteMs: now });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(path.dirname(file)), [path.basename(file)], "no temporary file is left");
    assert.deepEqual(await store.read(ACCOUNT), {
        record: { accessRT: "synthetic-refresh", accessST: "synthetic-st", lastWriteMs: now }, writtenAtMs: now, readAtMs: now });
    const none = { record: null, writtenAtMs: null, readAtMs: now };
    await writeFile(file, "{ torn");
    assert.deepEqual(await store.read(ACCOUNT), none);
    await rm(file);
    assert.deepEqual(await store.read(ACCOUNT), none);
    assert.deepEqual(await store.source(undefined).read(), none, "a site without an account has no credentials");
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
