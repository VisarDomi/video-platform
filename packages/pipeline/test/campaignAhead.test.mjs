// Converting ahead (the sites file names a second uplink): conversion never waits for upload
// allowance, a cooldown or an attention hold; only a manual pause stops everything; the cap
// (one carrier's worth plus two days of home's allowance) and the free-space floor stop
// admission; a file on a carrier never uploads from home; the account slot is respected.
// Without the setting, the campaign behaves as before.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { pipelineConfig } from "../dist/config.js";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { CampaignWorker } from "../dist/campaign/campaignWorker.js";
import { AccountSlot } from "../dist/campaign/accountSlot.js";
import { TargetCatalogResolver } from "../dist/provenance/targetResolver.js";
import { inspectFinalizedRecording } from "../dist/discovery/inspectRecording.js";
import { HumanActionRequiredError } from "../dist/upload/browserUpload.js";

const GB = 1_000_000_000;
const NOW = new Date("2026-11-24T10:00:00Z");

async function addFinalized(authority, root, folderName) {
    const recordingPath = path.join(root, folderName);
    await mkdir(recordingPath, { recursive: true });
    const playlist = "#EXTM3U\n#EXTINF:180,\n1.ts\n#EXT-X-ENDLIST\n";
    await writeFile(path.join(recordingPath, "playlist.m3u8"), playlist);
    await writeFile(path.join(recordingPath, "1.ts"), "media");
    authority.prepare("INSERT INTO integrity_checkpoints VALUES (?, ?, ?, ?)").run(recordingPath,
        createHash("sha256").update(playlist).digest("hex"), JSON.stringify({ version: 2, status: "ready" }), "2026-08-14T08:00:00.000Z");
    return recordingPath;
}

function makeReady(database, recording, directory, sizeBytes) {
    database.transition(recording.id, "server_ready", "remuxed");
    const sha256 = createHash("sha256").update(recording.id).digest("hex");
    database.saveArtifact(recording.id, { path: path.join(directory, recording.id + ".mp4"), sizeBytes, sha256, validatedAt: NOW.toISOString() });
    database.saveDescription(recording.id, { artifactSha256: sha256, promptVersion: "test-v1", fps: 2,
        output: { title: "Title", description: "Description.", tags: ["room"] }, evidencePath: path.join(directory, "evidence.json") });
    database.saveProvenance(recording.id, { observedIdentifier: "alias", status: "resolved", streamerId: "streamer-id", alias: "alias",
        streamerUrl: "https://live-a.example/streamer-id", aliasUrl: null, reason: null, updatedAt: NOW.toISOString() });
    database.saveUploadMetadata(recording.id, { title: "Title [alias]", description: "Description.", tags: ["live-a"] });
    database.recordResolutionPolicyAssessment(recording.id, "resolution-policy-v6: test fixture");
}

// `ready` recordings converted and waiting for upload (oldest first), `local` admitted and
// not converted yet, `unadmitted` finalized sources the campaign has not taken in.
async function fixture(t, { ready = [], local = [], unadmitted = [], uplink = true, minFreeBytes = 1, capacityBytes = 230 * GB } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-ahead-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const edited = path.join(root, "live-a", "edited");
    const authority = new DatabaseSync(path.join(root, "finalization.sqlite"));
    authority.exec("CREATE TABLE integrity_checkpoints (recording_path TEXT PRIMARY KEY, playlist_fingerprint TEXT NOT NULL, report_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT");
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const recordings = {};
    for (const [name, size] of ready) {
        const recording = database.discover((await inspectFinalizedRecording(await addFinalized(authority, edited, name), "live-a", "edited")).recording);
        makeReady(database, recording, root, size);
        recordings[name] = recording;
    }
    for (const name of local) {
        recordings[name] = database.discover((await inspectFinalizedRecording(await addFinalized(authority, edited, name), "live-a", "edited")).recording);
    }
    for (const name of unadmitted) await addFinalized(authority, edited, name);
    authority.close();
    database.configureCampaign("all", 25 * GB);
    database.setCampaignState("running", NOW);
    const config = { ...pipelineConfig, comparisonTrialOnly: false, automaticShortsEnabled: false, networkUploadsEnabled: true,
        finalizationDatabasePath: path.join(root, "finalization.sqlite"), stagingRoot: root, artifactsRoot: root,
        discoveryRoots: [{ provider: "live-a", sourceKind: "edited", path: edited }],
        uplink: uplink ? { id: "office", dailyBytes: 50 * GB, network: { gateway: "x" }, carrier: { path: "/c", capacityBytes, remoteMount: "/c" },
            runner: ["true"], minFreeBytes } : null };
    const resolver = TargetCatalogResolver.load({ resolveIdentifier: async () => null });
    const uploads = [], conversions = [];
    const make = (options = {}, upload = async (id) => { uploads.push(id); database.transition(id, "metadata_ready", "upload_admitted");
        database.transition(id, "upload_admitted", "uploading"); database.transition(id, "uploading", "upload_uncertain"); return {}; }) => {
        const worker = new CampaignWorker(database, config, resolver, upload, undefined, options);
        // Conversion itself is the orchestrator's (tested elsewhere): here it is one call.
        worker.orchestrator.processRecording = async (id) => { conversions.push(id); makeReady(database, database.get(id), root, 1 * GB); return database.get(id); };
        return worker;
    };
    const spend = (bytes, at = NOW) => {
        const raw = new DatabaseSync(path.join(root, "pipeline.sqlite"));
        raw.prepare(`INSERT INTO bandwidth_events (recording_id, attempt_id, provider, calendar_month, transmitted_bytes, created_at, uplink)
            VALUES ('x', 'x', 'form-host', '2026-11', ?, ?, 'home')`).run(bytes, at.toISOString());
        raw.close();
    };
    return { root, database, config, recordings, make, uploads, conversions, spend };
}

test("a spent allowance does not stop conversion; the next day the oldest ready file uploads first", async (t) => {
    const f = await fixture(t, { ready: [["2026-01-01 010000 a", 1 * GB]], local: ["2026-01-02 010000 b"] });
    f.spend(50 * GB);
    const step = await f.make().step(NOW);
    assert.deepEqual([step.disposition, step.recordingId], ["stage_completed", f.recordings["2026-01-02 010000 b"].id]);
    assert.deepEqual(f.uploads, []);
    const tomorrow = new Date("2026-11-25T10:00:00Z");
    const next = await f.make().step(tomorrow);
    assert.equal(next.disposition, "upload_completed");
    assert.deepEqual(f.uploads, [f.recordings["2026-01-01 010000 a"].id]);
});

test("without the setting a ready recording waiting for allowance still stops conversion", async (t) => {
    const f = await fixture(t, { ready: [["2026-01-01 010000 a", 1 * GB]], local: ["2026-01-02 010000 b"], uplink: false });
    f.spend(50 * GB);
    const config = { ...f.config, automaticShortsEnabled: true };
    const worker = new CampaignWorker(f.database, config, TargetCatalogResolver.load({ resolveIdentifier: async () => null }), async () => ({}));
    worker.orchestrator.processRecording = async (id) => { f.conversions.push(id); return f.database.get(id); };
    assert.equal((await worker.step(NOW)).disposition, "upload_quota_wait");
    assert.deepEqual(f.conversions, []);
});

test("a cooldown and an attention hold hold uploads only; a manual pause stops everything", async (t) => {
    const f = await fixture(t, { ready: [["2026-01-01 010000 a", 1 * GB]], local: ["2026-01-02 010000 b", "2026-01-03 010000 c"] });
    f.database.recordAntibotFailure(1, 60 * 60_000, NOW);
    assert.equal((await f.make().step(NOW)).disposition, "stage_completed");
    f.database.setCampaignState("running", NOW);
    f.database.pauseForAttention("Destination shared session is logged out; restore it", NOW);
    assert.equal((await f.make().step(NOW)).disposition, "stage_completed");
    assert.deepEqual(f.uploads, [], "nothing uploaded while held");
    assert.equal(f.conversions.length, 2);
    f.database.setCampaignState("paused", NOW);
    assert.equal((await f.make().step(NOW)).disposition, "paused");
    assert.equal(f.conversions.length, 2);
    // A cooldown that has passed resumes uploads.
    f.database.recordAntibotFailure(1, 60_000, NOW);
    assert.equal((await f.make().step(new Date(NOW.getTime() + 120_000))).disposition, "upload_completed");
});

test("a failed upload's cooldown does not stop the next conversion", async (t) => {
    const f = await fixture(t, { ready: [["2026-01-01 010000 a", 1 * GB]], local: ["2026-01-02 010000 b"] });
    const worker = f.make({}, async () => { throw new HumanActionRequiredError("captcha", "a captcha"); });
    assert.equal((await worker.step(NOW)).disposition, "antibot_cooldown");
    assert.equal((await worker.step(NOW)).disposition, "stage_completed");
    assert.equal(f.database.getCampaignControl().state, "paused", "the cooldown is still recorded");
});

test("the cap and the free-space floor stop admission, not local work", async (t) => {
    // Cap: 10 GB carrier + 2 x 25 GB = 60 GB; 61 GB ready.
    const f = await fixture(t, { ready: [["2026-01-01 010000 a", 61 * GB]], unadmitted: ["2026-01-05 010000 new"], capacityBytes: 10 * GB });
    f.spend(50 * GB);
    const full = await f.make().step(NOW);
    assert.equal(full.disposition, "full_ahead");
    assert.deepEqual([full.readyBytes, full.limitBytes, full.admits], [61 * GB, 60 * GB, false]);
    assert.equal(full.uploads, "waiting for home's allowance");
    const g = await fixture(t, { ready: [["2026-01-01 010000 a", 1 * GB]], unadmitted: ["2026-01-05 010000 new"], minFreeBytes: Number.MAX_SAFE_INTEGER });
    g.spend(50 * GB);
    assert.equal((await g.make().step(NOW)).disposition, "full_ahead");
    const h = await fixture(t, { ready: [["2026-01-01 010000 a", 1 * GB]], unadmitted: ["2026-01-05 010000 new"] });
    h.spend(50 * GB);
    assert.equal((await h.make().step(NOW)).disposition, "admitted");
});

test("an older source is admitted before newer local work; the oldest local stage goes first", async (t) => {
    const f = await fixture(t, { local: ["2026-01-03 010000 c", "2026-01-02 010000 b"], unadmitted: ["2026-01-01 010000 a"] });
    assert.equal((await f.make().step(NOW)).disposition, "admitted");
    const step = await f.make().step(NOW);
    assert.equal(step.disposition, "stage_completed");
    assert.match(f.conversions[0], /2026-01-01 010000 a/);
});

test("a file on a carrier never uploads from home; the next ready one does", async (t) => {
    const f = await fixture(t, { ready: [["2026-01-01 010000 a", 1 * GB], ["2026-01-02 010000 b", 1 * GB]] });
    const raw = new DatabaseSync(path.join(f.root, "pipeline.sqlite"));
    raw.prepare(`INSERT INTO carrier_files (carrier_id, file_name, recording_id, artifact_part, size_bytes, sha256, state, copied_at)
        VALUES ('CARRIER1', 'a.mp4', ?, 'full', 1, 'h', 'copied', ?)`).run(f.recordings["2026-01-01 010000 a"].id, NOW.toISOString());
    raw.close();
    assert.equal((await f.make().step(NOW)).disposition, "upload_completed");
    assert.deepEqual(f.uploads, [f.recordings["2026-01-02 010000 b"].id]);
});

test("a held verification or a busy account slot skips the upload and converts", async (t) => {
    const f = await fixture(t, { ready: [["2026-01-01 010000 a", 1 * GB]], local: ["2026-01-02 010000 b", "2026-01-03 010000 c"] });
    assert.equal((await f.make({ uploadHold: "the daily verification failed: list short" }).step(NOW)).disposition, "stage_completed");
    const slot = new AccountSlot();
    const release = slot.tryTake("office-upload");
    assert.equal((await f.make({ slot }).step(NOW)).disposition, "stage_completed");
    assert.deepEqual(f.uploads, []);
    release();
    assert.equal((await f.make({ slot }).step(NOW)).disposition, "upload_completed");
    assert.equal(slot.heldBy, null, "the upload gave the slot back");
});

test("the account slot: one holder; a waiter gets it when it is given back", async () => {
    const slot = new AccountSlot();
    const first = slot.tryTake("a");
    assert.equal(slot.tryTake("b"), null);
    let got = false;
    const waiting = slot.take("c").then((release) => { got = true; return release; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(got, false);
    first();
    first();
    const release = await waiting;
    assert.equal(slot.heldBy, "c");
    release();
    assert.deepEqual(await slot.ifFree("d", () => 7), { value: 7 });
    const busy = slot.tryTake("e");
    assert.equal(await slot.ifFree("f", () => 8), null);
    busy();
});

test("ahead mode resolves missing provenance on already-discovered recordings before composing metadata", async (t) => {
    const f = await fixture(t, { local: ["2026-01-23 150039 990001"] });
    const rec = f.recordings["2026-01-23 150039 990001"];
    f.database.transition(rec.id, "server_ready", "remuxed");
    const sha256 = "c".repeat(64);
    f.database.saveArtifact(rec.id, { path: path.join(f.root, rec.id + ".mp4"), sizeBytes: 1_000, sha256, validatedAt: NOW.toISOString() });
    f.database.saveDescription(rec.id, {
        artifactSha256: sha256, promptVersion: "test-v1", fps: 2,
        output: { title: "Title", description: "Description.", tags: [] },
        evidencePath: path.join(f.root, "evidence.json"),
    });
    f.database.recordResolutionPolicyAssessment(rec.id, "resolution-policy-v6: test fixture");
    assert.equal(f.database.getProvenance(rec.id), null);
    const resolver = TargetCatalogResolver.load({
        resolveIdentifier: async (_provider, identifier) => ({
            id: identifier, label: identifier, channelUrl: `https://live-a.example/${identifier}/`, aliasUrl: null,
        }),
    });
    const worker = new CampaignWorker(f.database, f.config, resolver);
    const step = await worker.step(NOW);
    assert.equal(step.disposition, "stage_completed");
    assert.equal(step.recordingId, rec.id);
    assert.equal(step.state, "metadata_ready");
    assert.equal(f.database.getProvenance(rec.id)?.streamerUrl, "https://live-a.example/990001/");
});
