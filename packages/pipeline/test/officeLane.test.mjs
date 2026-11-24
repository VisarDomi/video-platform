// The office lane: with the carrier away from the PC and the runner (the real one, run here)
// on the uplink's network, it sends the oldest file the drive holds within the office's own
// allowance, holding the account slot; the wrong network or no drive sends nothing; a
// failure holds this lane only; a refused copy is home's again; with nothing left, the drive
// is released and "done" is said once.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HumanActionRequiredError, TransferAbortedBeforeSubmissionError } from "sdk";

import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { AccountSlot } from "../dist/campaign/accountSlot.js";
import { DirectoryCarrier } from "../dist/uplink/carrier.js";
import { carrierPass } from "../dist/uplink/carrierLane.js";
import { initCarrier } from "../dist/uplink/carrierCommands.js";
import { officeTick } from "../dist/uplink/officeLane.js";

const RUNNER = fileURLToPath(new URL("../dist/uplinkRunner.js", import.meta.url));
const NOW = new Date("2026-11-24T10:00:00Z");
const SIZE = 4_000;

async function fixture(t, count = 3) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-office-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const databasePath = path.join(root, "pipeline.sqlite");
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    // Home keeps nothing back (its allowance is spent and tiny): everything goes on the drive.
    database.configureCampaign("all", 1);
    database.setCampaignState("running", NOW);
    const recordings = [];
    for (let i = 1; i <= count; i++) {
        const name = `2026-01-0${i} 010000 alias`;
        const recording = database.discover({ provider: "live-a", sourceKind: "edited", sourcePath: path.join(root, "edited", name),
            playlistPath: path.join(root, "edited", name, "p.m3u8"), sourceFingerprint: `f${i}`, durationSeconds: 600 });
        const bytes = randomBytes(SIZE);
        const file = path.join(root, `${name}.production-v6.mp4`);
        await writeFile(file, bytes);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        database.transition(recording.id, "server_ready", "remuxed");
        database.saveArtifact(recording.id, { path: file, sizeBytes: SIZE, sha256, validatedAt: NOW.toISOString() });
        database.saveDescription(recording.id, { artifactSha256: sha256, promptVersion: "v", fps: 2, output: { title: "T", description: "D.", tags: ["x"] }, evidencePath: file });
        database.saveProvenance(recording.id, { observedIdentifier: "alias", status: "resolved", streamerId: "s", alias: "alias",
            streamerUrl: "https://live-a.example/s", aliasUrl: null, reason: null, updatedAt: NOW.toISOString() });
        database.saveUploadMetadata(recording.id, { title: "T [alias]", description: "D.", tags: ["x"] });
        database.recordResolutionPolicyAssessment(recording.id, "resolution-policy-v6: test");
        recordings.push({ id: recording.id, name: path.basename(file) });
    }
    const drive = path.join(root, "CARRIER1");
    await mkdir(drive);
    const carrier = new DirectoryCarrier(drive);
    await initCarrier({ uplink: {} }, carrier);
    await carrierPass(database, { uploadTimeZone: "Europe/Tirane" }, carrier, { now: () => NOW });
    assert.equal(database.carrierFiles("CARRIER1", "copied").length, count);
    database.saveCarrierState("CARRIER1", { location: "away", freeBytes: null, note: null }, NOW);
    // The supervised first upload from the office (upload-one) settled with a video ID.
    const seed = new DatabaseSync(databasePath);
    seed.prepare(`INSERT INTO upload_attempts (id, recording_id, provider, status, started_at, remote_id, uplink)
        VALUES ('first', ?, 'form-host', 'uncertain', ?, '1', 'office')`).run(recordings[0].id, NOW.toISOString());
    seed.close();
    const network = path.join(root, "network");
    await writeFile(network, "office-net\n");
    const info = path.join(root, "runner.json");
    await writeFile(info, JSON.stringify({ commit: "c1" }));
    await writeFile(path.join(root, "uplink-runner.json"), JSON.stringify({ commit: "c1" }));
    const config = { databasePath, uploadTimeZone: "Europe/Tirane", networkUploadsEnabled: true,
        uplink: { id: "office", dailyBytes: 100_000_000, network: { gateway: "office-net", probe: ["cat", network] },
            carrier: { path: drive, capacityBytes: 1e9, remoteMount: drive }, minFreeBytes: 1,
            runner: ["env", `VIDEO_UPLINK_RUNNER_INFO=${info}`, process.execPath, "--no-warnings", RUNNER] } };
    const uploads = [], notices = [];
    const sent = async (id) => {
        uploads.push(id);
        database.transition(id, "metadata_ready", "upload_admitted");
        database.transition(id, "upload_admitted", "uploading");
        database.transition(id, "uploading", "upload_uncertain");
        return { uplink: "office" };
    };
    const tick = (options = {}) => officeTick(config, options.slot ?? null, (notice) => notices.push(notice), { now: () => NOW, upload: sent, ...options });
    return { root, database, databasePath, drive, network, recordings, config, uploads, notices, tick };
}

test("on the office network with the drive there: the oldest file goes, then the next; then 'done' once", async (t) => {
    const f = await fixture(t);
    const slot = new AccountSlot();
    for (const r of f.recordings) {
        const tick = await f.tick({ slot });
        assert.deepEqual([tick.action, tick.recordingId], ["uploaded", r.id]);
    }
    assert.deepEqual(f.uploads, f.recordings.map((r) => r.id));
    assert.equal(slot.heldBy, null);
    assert.equal(f.database.carrierState("CARRIER1").location, "uplink");
    assert.equal((await f.tick()).action, "done");
    assert.equal((await f.tick()).action, "done");
    assert.deepEqual(f.notices, ["done"]);
});

test("another network, a missing drive, or the drive at home: nothing is sent", async (t) => {
    const f = await fixture(t);
    await writeFile(f.network, "home-net\n");
    const elsewhere = await f.tick();
    assert.equal(elsewhere.action, "away");
    assert.match(elsewhere.detail, /network home-net/);
    await writeFile(f.network, "office-net\n");
    await rename(f.drive, `${f.drive}-gone`);
    assert.equal((await f.tick()).action, "away");
    await rename(`${f.drive}-gone`, f.drive);
    f.database.saveCarrierState("CARRIER1", { location: "home", freeBytes: null, note: null }, NOW);
    assert.equal((await f.tick()).action, "carrier_home");
    assert.deepEqual(f.uploads, []);
});

test("the office's own allowance, the account slot, a manual pause and a lost session hold it", async (t) => {
    const f = await fixture(t);
    const db = new DatabaseSync(f.databasePath);
    t.after(() => db.close());
    // Twice the office's daily amount already sent today from the office.
    db.prepare(`INSERT INTO bandwidth_events (recording_id, attempt_id, provider, calendar_month, transmitted_bytes, created_at, uplink)
        VALUES ('x', 'x', 'form-host', '2026-11', ?, ?, 'office')`).run(200_000_000, NOW.toISOString());
    assert.equal((await f.tick()).action, "waiting_allowance");
    db.prepare("DELETE FROM bandwidth_events").run();
    const slot = new AccountSlot();
    const release = slot.tryTake("home-upload");
    assert.equal((await f.tick({ slot })).action, "busy");
    release();
    f.database.setCampaignState("paused", NOW);
    assert.equal((await f.tick()).action, "held");
    f.database.pauseForAttention("Destination shared session is logged out", NOW);
    assert.match((await f.tick()).detail, /logged out/);
    // A cooldown of the home campaign does not hold the office.
    f.database.setCampaignState("running", NOW);
    f.database.recordAntibotFailure(1, 3_600_000, NOW);
    assert.equal((await f.tick()).action, "uploaded");
});

test("a failure holds the office lane only, longer each time; a person-needed failure a day; a refused copy is home's again", async (t) => {
    const f = await fixture(t);
    const before = f.database.getCampaignControl();
    const failing = (error) => async () => { throw error; };
    const first = await f.tick({ upload: failing(new Error("page timeout")) });
    assert.equal(first.action, "failed");
    assert.equal(f.database.uplinkHold("office").resumeAt, new Date(NOW.getTime() + 15 * 60_000).toISOString());
    assert.equal((await f.tick()).action, "held");
    const later = new Date(NOW.getTime() + 16 * 60_000);
    await f.tick({ now: () => later, upload: failing(new Error("page timeout")) });
    assert.equal(f.database.uplinkHold("office").resumeAt, new Date(later.getTime() + 30 * 60_000).toISOString());
    assert.deepEqual(f.database.getCampaignControl(), before, "the home campaign is untouched");
    const evenLater = new Date(NOW.getTime() + 60 * 60_000);
    await f.tick({ now: () => evenLater, upload: failing(new HumanActionRequiredError("captcha", "a captcha")) });
    assert.equal(f.database.uplinkHold("office").resumeAt, new Date(evenLater.getTime() + 24 * 3_600_000).toISOString());
    assert.deepEqual(f.notices, ["person"]);
    f.database.clearUplinkHold("office", evenLater);
    const refused = await f.tick({ now: () => evenLater, upload: failing(new TransferAbortedBeforeSubmissionError(
        `uplink: carrier file ${f.recordings[0].name} does not match its ledger hash; nothing was sent`)) });
    assert.equal(refused.action, "failed");
    assert.equal(f.database.carrierCopy(f.recordings[0].id), null, "home's again");
    assert.equal(f.database.uplinkHold("office").failures, 0, "not the office's failure");
    // A success clears the backoff.
    f.database.recordUplinkFailure("office", "x", false, new Date(0));
    assert.equal((await f.tick({ now: () => evenLater })).action, "uploaded");
    assert.equal(f.database.uplinkHold("office").failures, 0);
});

test("before the supervised first upload from the office, the lane sends nothing", async (t) => {
    const f = await fixture(t);
    const db = new DatabaseSync(f.databasePath);
    t.after(() => db.close());
    db.prepare("DELETE FROM upload_attempts WHERE id = 'first'").run();
    assert.equal((await f.tick()).action, "awaiting_first_upload");
    assert.deepEqual(f.uploads, []);
});
