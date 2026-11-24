// The carrier at home, with a directory standing in for the drive: a pass cleans (what the
// site accepted, what is stale, what the ledger does not know, unfinished copies), checks
// (a recorded file that is gone is the PC's again), and copies what home does not keep in
// its reserve, oldest first, file first and row second. A pull at any moment leaves a state
// the next pass repairs; a recall gives files back except one whose upload is in flight.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { DirectoryCarrier, carrierFileNameOk } from "../dist/uplink/carrier.js";
import { carrierPass, runCarrierLane } from "../dist/uplink/carrierLane.js";
import { initCarrier, recallCarrier, writeOffCarrier } from "../dist/uplink/carrierCommands.js";

const NOW = new Date("2026-11-24T10:00:00Z");
const SIZE = 4_000;

async function fixture(t, count = 5) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-carrier-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const databasePath = path.join(root, "pipeline.sqlite");
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    // 3000 bytes a day: on the 24th home may still send 6000 today, so it keeps 9000 bytes
    // (two files) in reserve.
    database.configureCampaign("all", 3_000);
    const artifacts = path.join(root, "artifacts");
    await mkdir(artifacts);
    const recordings = [];
    for (let i = 1; i <= count; i++) {
        const name = `2026-01-0${i} 010000 alias`;
        const recording = database.discover({ provider: "live-a", sourceKind: "edited", sourcePath: path.join(root, "edited", name),
            playlistPath: path.join(root, "edited", name, "playlist.m3u8"), sourceFingerprint: `f${i}`, durationSeconds: 600 });
        const bytes = randomBytes(SIZE);
        const file = path.join(artifacts, `${name}.production-v6.mp4`);
        await writeFile(file, bytes);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        database.transition(recording.id, "server_ready", "remuxed");
        database.saveArtifact(recording.id, { path: file, sizeBytes: SIZE, sha256, validatedAt: NOW.toISOString() });
        database.saveDescription(recording.id, { artifactSha256: sha256, promptVersion: "v", fps: 2,
            output: { title: "T", description: "D.", tags: ["x"] }, evidencePath: path.join(root, "e.json") });
        database.saveProvenance(recording.id, { observedIdentifier: "alias", status: "resolved", streamerId: "s", alias: "alias",
            streamerUrl: "https://live-a.example/s", aliasUrl: null, reason: null, updatedAt: NOW.toISOString() });
        database.saveUploadMetadata(recording.id, { title: "T [alias]", description: "D.", tags: ["x"] });
        database.recordResolutionPolicyAssessment(recording.id, "resolution-policy-v6: test");
        recordings.push({ id: recording.id, name: path.basename(file), sha256 });
    }
    const drive = path.join(root, "CARRIER1");
    await mkdir(drive);
    const carrier = new DirectoryCarrier(drive);
    await initCarrier({ uplink: {} }, carrier);
    const notices = [];
    const pass = (options = {}) => carrierPass(database, { uploadTimeZone: "Europe/Tirane" }, options.carrier ?? carrier,
        { now: () => options.now ?? NOW, notify: (notice) => notices.push(notice), ...options });
    const onDrive = async () => (await readdir(path.join(drive, "files"))).sort();
    const raw = () => { const db = new DatabaseSync(databasePath); t.after(() => db.close()); return db; };
    return { root, database, databasePath, drive, carrier, recordings, pass, notices, onDrive, raw };
}

test("set-up: the marker, the files folder, Spotlight kept out; only an empty drive or the same carrier", async (t) => {
    const f = await fixture(t, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.drive, "carrier.json"), "utf8")), { carrier: "CARRIER1", version: 1 });
    assert.deepEqual((await readdir(f.drive)).sort(), [".metadata_never_index", "carrier.json", "files"]);
    assert.equal((await initCarrier({ uplink: {} }, f.carrier)).initialized, false, "a second set-up changes nothing");
    const other = path.join(f.root, "OTHER");
    await mkdir(other);
    await writeFile(path.join(other, "holiday.jpg"), "x");
    await assert.rejects(initCarrier({ uplink: {} }, new DirectoryCarrier(other)), /not empty/);
    assert.equal(carrierFileNameOk("2026-01-01 010000 alias.production-v6.mp4"), true);
    for (const bad of ["a:b.mp4", "a/b", ".hidden", "x?.mp4", "trailing. "]) assert.equal(carrierFileNameOk(bad), false, bad);
});

test("home keeps its reserve; the rest is copied oldest first, read back and recorded; then 'ready' once", async (t) => {
    const f = await fixture(t);
    const result = await f.pass();
    assert.deepEqual(result.copied, f.recordings.slice(2).map((r) => r.name), "the two oldest stay home");
    assert.deepEqual(await f.onDrive(), f.recordings.slice(2).map((r) => r.name).sort());
    for (const r of f.recordings.slice(2)) {
        assert.equal(createHash("sha256").update(await readFile(path.join(f.drive, "files", r.name))).digest("hex"), r.sha256);
        assert.equal(f.database.carrierCopy(r.id).carrierId, "CARRIER1");
    }
    assert.equal(f.database.carrierCopy(f.recordings[0].id), null);
    assert.deepEqual(f.notices, ["ready"]);
    const state = f.database.carrierState("CARRIER1");
    assert.deepEqual([state.location, state.inTransitBytes], ["home", 3 * SIZE]);
    assert.equal((await f.pass()).copied.length, 0);
    assert.deepEqual(f.notices, ["ready"], "said once per plug-in");
    // A file on the carrier never goes up from home.
    assert.throws(() => f.database.reserveUpload(f.recordings[2].id, SIZE, NOW, "Europe/Tirane", 3_000), /on a carrier/);
});

test("clean: unfinished copies, unknown files, accepted uploads and stale files go; check: a vanished file is home's again", async (t) => {
    const f = await fixture(t);
    await f.pass();
    const [, , accepted, stale, vanished] = f.recordings;
    await writeFile(path.join(f.drive, "files", "left-over.mp4"), "x");
    await writeFile(path.join(f.drive, "files", `${f.recordings[0].name}.partial`), "x");
    // The site accepted one (an office upload: the receipt with its remote ID).
    const db = f.raw();
    db.prepare(`INSERT INTO upload_attempts (id, recording_id, provider, status, started_at, remote_id, uplink)
        VALUES ('a1', ?, 'form-host', 'uncertain', ?, '77', 'office')`).run(accepted.id, NOW.toISOString());
    db.prepare(`INSERT INTO upload_artifact_receipts (attempt_id, recording_id, artifact_part, path, size_bytes, sha256, source_fingerprint,
        source_path, metadata_json, accepted_at) VALUES ('a1', ?, 'full', 'p', ?, ?, 'f', 's', '{}', ?)`).run(accepted.id, SIZE, accepted.sha256, NOW.toISOString());
    db.prepare("UPDATE recordings SET state = 'upload_uncertain' WHERE id = ?").run(accepted.id);
    // Another was converted again (a new hash).
    db.prepare("UPDATE artifacts SET sha256 = ? WHERE recording_id = ?").run("0".repeat(64), stale.id);
    // A third disappeared from the drive.
    await rm(path.join(f.drive, "files", vanished.name));
    const result = await f.pass();
    assert.deepEqual(result.deleted.map((d) => [d.file, d.why]).sort(), [
        [`${f.recordings[0].name}.partial`, "an unfinished copy"],
        [accepted.name, "the site accepted it"],
        ["left-over.mp4", "not in the ledger"],
        [stale.name, "stale"],
    ].sort());
    assert.deepEqual(result.lost, [vanished.name]);
    const states = Object.fromEntries(f.database.carrierFiles("CARRIER1").map((row) => [row.fileName, row.state]));
    assert.deepEqual([states[accepted.name], states[stale.name]], ["uploaded", "removed"]);
    // The vanished one is home's again: copied anew in the same pass (beyond the reserve).
    assert.deepEqual(result.copied, [vanished.name]);
    assert.equal(states[vanished.name], "copied");
});

test("a crash between the file and its row: the file is deleted; a pull mid-copy changes nothing the next pass does not repair", async (t) => {
    const f = await fixture(t);
    // A file that made it to its final name, but whose row was never written.
    await writeFile(path.join(f.drive, "files", f.recordings[4].name), await readFile(path.join(f.root, "artifacts", f.recordings[4].name)));
    // The drive is pulled while the second file is copied.
    let calls = 0;
    const pulled = path.join(f.root, "pulled");
    const pulling = Object.assign(Object.create(Object.getPrototypeOf(f.carrier)), f.carrier, {
        freeBytes: async (root) => { if (++calls === 2) await rename(f.drive, pulled); return 10 * 1e12; },
    });
    const first = await f.pass({ carrier: pulling });
    assert.ok(first.gone, "the pass stops: the drive is gone");
    assert.deepEqual(first.deleted.map((d) => d.why), ["not in the ledger"]);
    assert.equal(first.copied.length, 1);
    assert.equal(f.database.carrierFiles("CARRIER1", "copied").length, 1, "only the finished copy is recorded");
    // Plugged back in: the pass finishes the job.
    await rename(pulled, f.drive);
    const second = await f.pass();
    assert.equal(second.gone, undefined);
    assert.deepEqual([...first.copied, ...second.copied].sort(), f.recordings.slice(2).map((r) => r.name).sort());
    assert.deepEqual(await f.onDrive(), f.recordings.slice(2).map((r) => r.name).sort());
    // Gone from the PC entirely: the carrier is "away".
    await rename(f.drive, pulled);
    assert.equal((await f.pass()).present, false);
    assert.equal(f.database.carrierState("CARRIER1").location, "away");
});

test("a full carrier says 'take it to the office' once; a home upload taking a file mid-copy keeps it off the carrier", async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const small = Object.assign(Object.create(Object.getPrototypeOf(f.carrier)), f.carrier,
        { freeBytes: async () => (calls++ === 0 ? 1e9 + 1.5 * SIZE : 1e9 + 0.5 * SIZE) });
    const result = await f.pass({ carrier: small });
    assert.equal(result.full, true);
    assert.equal(result.copied.length, 1);
    assert.deepEqual(f.notices, ["full"]);
    await f.pass({ carrier: small });
    assert.deepEqual(f.notices, ["full"]);
    // A recording that left the ready queue during its copy is not recorded, and its copy goes.
    const racing = Object.assign(Object.create(Object.getPrototypeOf(f.carrier)), f.carrier, {
        freeBytes: async () => { if (f.database.get(f.recordings[3].id).state === "metadata_ready") f.database.reserveUpload(f.recordings[3].id, SIZE, NOW, "Europe/Tirane", 3_000); return 1e12; },
    });
    const raced = await f.pass({ carrier: racing, maxCopies: 1 });
    assert.deepEqual(raced.refused.map((r) => r.why), ["it left the ready queue while it was copied"]);
    assert.ok(!(await f.onDrive()).includes(f.recordings[3].name));
});

test("an unknown drive is refused once; recall gives files back except one in flight; a lost carrier is written off", async (t) => {
    const f = await fixture(t);
    const stranger = path.join(f.root, "STRANGER");
    await mkdir(path.join(stranger, "files"), { recursive: true });
    await writeFile(path.join(stranger, "carrier.json"), JSON.stringify({ carrier: "CARRIER9" }));
    const unknown = Object.assign(Object.create(Object.getPrototypeOf(f.carrier)), f.carrier, { open: async () => stranger });
    assert.equal((await f.pass({ carrier: unknown })).marker, "other");
    assert.equal((await f.pass({ carrier: unknown })).marker, "other");
    assert.deepEqual(f.notices, ["unknown"]);
    assert.deepEqual(await readdir(path.join(stranger, "files")), [], "nothing copied to it");

    await f.pass();
    const busy = f.recordings[2];
    const db = f.raw();
    db.prepare(`INSERT INTO upload_attempts (id, recording_id, provider, status, started_at, uplink)
        VALUES ('a2', ?, 'form-host', 'started', ?, 'office')`).run(busy.id, NOW.toISOString());
    const recalled = await recallCarrier({ databasePath: f.databasePath }, true, f.carrier, NOW);
    assert.deepEqual(recalled.refused, [{ file: busy.name, why: "an upload is in flight" }]);
    assert.deepEqual(recalled.recalled.sort(), f.recordings.slice(3).map((r) => r.name).sort());
    assert.deepEqual(await f.onDrive(), [busy.name]);
    assert.throws(() => writeOffCarrier({ databasePath: f.databasePath }, "CARRIER1"), /in flight/);
    db.prepare("UPDATE upload_attempts SET status = 'failed' WHERE id = 'a2'").run();
    assert.deepEqual(writeOffCarrier({ databasePath: f.databasePath }, "CARRIER1"), { carrier: "CARRIER1", settled: 1 });
    assert.equal(f.database.carrierCopy(busy.id), null, "home's again");
});

test("the lane opens an idle plugged drive once, and again only when the ledger has work for it", async (t) => {
    const f = await fixture(t, 2);
    let opens = 0;
    const counting = Object.assign(Object.create(Object.getPrototypeOf(f.carrier)), f.carrier, {
        open: async () => { opens++; return f.drive; } });
    const stop = new AbortController();
    const lane = runCarrierLane({ databasePath: f.databasePath, uploadTimeZone: "Europe/Tirane" }, stop.signal, () => {}, counting, 10);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(opens, 1, "both recordings are home's reserve: nothing to do after the first pass");
    // Home's allowance shrinks to nothing: its reserve becomes one daily amount (one file).
    f.database.configureCampaign("all", 4_000);
    const db = f.raw();
    db.prepare(`INSERT INTO bandwidth_events (recording_id, attempt_id, provider, calendar_month, transmitted_bytes, created_at)
        VALUES ('x', 'x', 'form-host', '2026-11', 96000, ?)`).run(new Date().toISOString());
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop.abort();
    await lane;
    assert.ok(opens >= 2);
    assert.deepEqual(await f.onDrive(), [f.recordings[1].name]);
});
