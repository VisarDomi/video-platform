import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { pipelineConfig } from "../dist/config.js";
import { syncComparisonSelection, writeComparisonReport } from "../dist/commands/comparisonTrial.js";
import { CampaignWorker } from "../dist/campaign/campaignWorker.js";
import { setCampaignRunning } from "../dist/commands/campaign.js";
import { guardUploadIdentity } from "../dist/commands/uploadIdentityGuard.js";
import { reconcileDueUploads } from "../dist/commands/reconcileUploads.js";
import { sweepMissingRecordings } from "../dist/commands/sweep.js";
import { uploadOne } from "../dist/commands/uploadOne.js";

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "comparison-v3-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = { ...pipelineConfig, comparisonTrialOnly: true,
        databasePath: path.join(root, "pipeline.sqlite"), finalizationDatabasePath: path.join(root, "finalization.sqlite"),
        artifactsRoot: path.join(root, "artifacts"), stagingRoot: path.join(root, "artifacts", "production-v3"),
        comparisonSelectionFile: path.join(root, "test-videos.txt"), cleanupEnabled: true, networkUploadsEnabled: true,
        discoveryRoots: [{ provider: "tango", sourceKind: "edited", path: path.join(root, "edited") }] };
    const authority = new DatabaseSync(config.finalizationDatabasePath);
    authority.exec("CREATE TABLE integrity_checkpoints (recording_path TEXT PRIMARY KEY, playlist_fingerprint TEXT, report_json TEXT, updated_at TEXT)");
    const paths = [];
    for (const id of ["2025-01-01 000000 unselected", "2025-01-02 000000 second", "2025-01-03 000000 first"]) {
        const dir = path.join(root, "edited", id);
        await mkdir(dir, { recursive: true });
        const playlist = "#EXTM3U\n#EXTINF:1,\n1.ts\n#EXT-X-ENDLIST\n";
        await writeFile(path.join(dir, "playlist.m3u8"), playlist);
        await writeFile(path.join(dir, "1.ts"), "synthetic metadata fixture");
        authority.prepare("INSERT INTO integrity_checkpoints VALUES (?, ?, ?, ?)").run(dir,
            createHash("sha256").update(playlist).digest("hex"), JSON.stringify({ version: 2, status: "ready" }), new Date().toISOString());
        paths.push(dir);
    }
    authority.close();
    await writeFile(config.comparisonSelectionFile, "# empty selection\n");
    await setCampaignRunning(config, false, true);
    const db = new PipelineDatabase(config.databasePath);
    t.after(() => db.close());
    const resolver = { resolve: async () => ({ observedIdentifier: "alias", status: "resolved", streamerId: "id", alias: "alias",
        streamerUrl: "https://tango.me/id", aliasUrl: null, reason: null, updatedAt: new Date().toISOString() }) };
    return { root, config, db, paths, resolver };
}

async function markSubmitted(db, config, id) {
    const artifactPath = path.join(config.stagingRoot, `${id}.production-upscale1080p.mp4`);
    await writeFile(artifactPath, "comparison evidence");
    db.transition(id, "server_ready", "remuxed");
    db.saveArtifact(id, { path: artifactPath, sizeBytes: 19, sha256: "a".repeat(64), validatedAt: new Date().toISOString() });
    db.saveDescription(id, { artifactSha256: "a".repeat(64), promptVersion: "test", fps: 1,
        output: { title: "Test title", description: "Test description" }, evidencePath: path.join(config.stagingRoot, "evidence.json") });
    db.saveUploadMetadata(id, { title: "Test title", description: "Test description", tags: [] });
    const reservation = db.reserveUpload(id, 100);
    const attempt = db.beginUpload(id, reservation);
    db.finishUploadAttempt(attempt, { status: "uncertain", transmittedBytes: 19, remoteId: "123456",
        confirmation: { confirmAfter: new Date(0) } });
    return artifactPath;
}

test("file controls pending additions, removals and ordering; missing file does not cancel the queue", async (t) => {
    const { config, db, paths } = await fixture(t);
    await writeFile(config.comparisonSelectionFile, `# selection\r\n${paths[2]}\r\n${paths[2]}\r\nrelative/bad\r\n`);
    const first = await syncComparisonSelection(config);
    assert.equal(first.added, 1);
    assert.equal(first.errors.length, 1);
    assert.equal(db.getCampaignControl().state, "paused");
    db.setCampaignState("running");
    await writeFile(config.comparisonSelectionFile, `${paths[1]}\n${paths[2]}\n`);
    assert.equal((await syncComparisonSelection(config)).added, 1);
    assert.deepEqual(db.getComparisonTrial().selection.map((s) => s.sourcePath), [paths[1], paths[2]]);
    const reopened = new PipelineDatabase(config.databasePath);
    assert.equal(reopened.getComparisonTrial().selection.length, 2);
    reopened.close();
    await writeFile(config.comparisonSelectionFile, "");
    assert.equal((await syncComparisonSelection(config)).removed, 2);
    await writeFile(config.comparisonSelectionFile, paths[2] + "\n");
    assert.equal((await syncComparisonSelection(config)).added, 1);
    assert.equal(db.getComparisonTrial().selection.length, 1);
    await rm(config.comparisonSelectionFile);
    assert.equal((await syncComparisonSelection(config)).errors.length, 1);
    assert.equal(db.getComparisonTrial().selection.length, 1);
});

test("removal cancels admitted but unstarted work; active/previously attempted work is retained without duplication", async (t) => {
    const { config, db, paths } = await fixture(t);
    await writeFile(config.comparisonSelectionFile, paths[2] + "\n");
    await syncComparisonSelection(config);
    const row = db.discover(db.getComparisonTrial().selection[0]);
    await writeFile(config.comparisonSelectionFile, "");
    assert.equal((await syncComparisonSelection(config)).removed, 1);
    assert.equal(db.comparisonAllows(row), false);
    assert(db.get(row.id), "removal does not erase database history");
    await writeFile(config.comparisonSelectionFile, paths[2] + "\n");
    await syncComparisonSelection(config);
    db.claimRecording(row.id, ["server_ready"], "active", 60_000);
    await writeFile(config.comparisonSelectionFile, "");
    assert.equal((await syncComparisonSelection(config)).removed, 0);
    assert.equal(db.getComparisonTrial().selection.length, 1);
    db.releaseLease(row.id, "active");
    assert.equal((await syncComparisonSelection(config)).removed, 0, "interrupted work also retains its evidence");
    await writeFile(config.comparisonSelectionFile, `${paths[2]}\n${paths[2]}\n`);
    assert.equal((await syncComparisonSelection(config)).added, 0);
    assert.equal(db.getComparisonTrial().selection.length, 1);
});

test("selected worker waits on an empty file and obeys file order, not oldest library order", async (t) => {
    const { config, db, paths, resolver } = await fixture(t);
    const worker = new CampaignWorker(db, config, resolver);
    db.setCampaignState("running");
    assert.equal((await worker.step()).disposition, "comparison_finished");
    assert.equal(db.list().length, 0);
    await writeFile(config.comparisonSelectionFile, `${paths[2]}\n${paths[1]}\n`);
    await syncComparisonSelection(config);
    const admitted = await worker.step();
    assert.equal(admitted.recordingId, path.basename(paths[2]));
    assert.equal(db.list().length, 1);
    db.transition(admitted.recordingId, "server_ready", "failed", "synthetic failure");
    assert.equal((await worker.step()).disposition, "comparison_attention_required");
    assert.equal(db.getCampaignControl().state, "paused");
    assert.equal(db.list().length, 1);
    const unselected = db.discover({ provider: "tango", sourceKind: "edited", sourcePath: paths[0],
        playlistPath: path.join(paths[0], "playlist.m3u8"), durationSeconds: 1, sourceFingerprint: "unselected" });
    await assert.rejects(() => uploadOne(unselected.id, config), /not in the explicit comparison selection/);
});

test("verification, identity guard and missing-source sweep retain comparison evidence even with cleanup enabled", async (t) => {
    const { config, db, paths, resolver } = await fixture(t);
    await writeFile(config.comparisonSelectionFile, paths[2] + "\n");
    await syncComparisonSelection(config);
    db.setCampaignState("running");
    const worker = new CampaignWorker(db, config, resolver);
    const { recordingId: id } = await worker.step();
    const artifactPath = await markSubmitted(db, config, id);
    assert.equal((await worker.step()).disposition, "comparison_verification_wait");
    db.setCampaignState("paused");
    await reconcileDueUploads(config, new Date(), {
        withAuthenticatedPage: async (run) => run({}),
        probeUploadStatus: async () => ({ outcome: "online", remoteUrl: "https://example.com/upload-123456" }),
    });
    assert.equal(db.get(id).state, "xvideos_verified");
    await access(artifactPath);
    await guardUploadIdentity(db, db.get(id), { cleanupEnabled: true });
    assert.equal(db.get(id).state, "xvideos_verified");
    await access(artifactPath);
    assert.equal(db.getCampaignControl().state, "paused", "verification must not override a manual pause");
    await rm(artifactPath);
    db.setCampaignState("running");
    assert.equal((await worker.step()).disposition, "comparison_attention_required");
    assert.equal(db.getCampaignControl().state, "paused");
    assert.equal(db.getComparisonTrial().completedAt, null);
    await writeFile(artifactPath, "comparison evidence");
    db.setCampaignState("running");
    assert.equal((await worker.step()).disposition, "comparison_finished");
    assert.equal(db.getCampaignControl().state, "running");
    assert(db.getComparisonTrial().completedAt);
    const report = await writeComparisonReport(config);
    assert.equal(report.recordings[0].artifactPath, artifactPath);
    assert.equal(report.recordings[0].uploadedUrl, "https://example.com/upload-123456");
    assert.equal(report.recordings[0].artifactExists, true);
    assert.match(await readFile(path.join(config.stagingRoot, "comparison.md"), "utf8"), /local MP4/);
    await rm(paths[2], { recursive: true });
    assert.deepEqual(await sweepMissingRecordings(db, config, new Date("2030-01-01")), []);
    await access(artifactPath);
    assert(db.get(id));
    db.setCampaignState("paused");
    await writeFile(config.comparisonSelectionFile, paths[1] + "\n");
    await syncComparisonSelection(config);
    assert.equal(db.getComparisonTrial().completedAt, null);
    assert.equal(db.getCampaignControl().state, "paused");
    db.finishComparisonTrial(1);
    assert.equal(db.getComparisonTrial().completedAt, null, "stale completion cannot hide a newly queued entry");
    db.setCampaignState("running");
    assert.equal((await worker.step()).recordingId, path.basename(paths[1]));
});

test("v3 resume fails closed when no comparison environment has been prepared", async (t) => {
    const { config, root } = await fixture(t);
    await assert.rejects(() => setCampaignRunning({ ...config, databasePath: path.join(root, "unprepared.sqlite") }, true), /Prepare v3/);
});
