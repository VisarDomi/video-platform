import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { pipelineConfig } from "../dist/config.js";
import { captureKeyFromFolderName, selectOldestFinalizedEditedCandidate } from "../dist/campaign/selectCandidate.js";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { CampaignWorker } from "../dist/campaign/campaignWorker.js";
import { TargetCatalogResolver } from "../dist/provenance/targetResolver.js";
import { inspectFinalizedRecording } from "../dist/discovery/inspectRecording.js";
import { HumanActionRequiredError } from "../dist/upload/chromiumXvideosUploader.js";

function advanceToMetadataReady(database, recording, directory, sizeBytes = 1_000) {
    database.transition(recording.id, "server_ready", "remuxed");
    const sha256 = "a".repeat(64);
    database.saveArtifact(recording.id, {
        path: path.join(directory, recording.id + ".mp4"),
        sizeBytes,
        sha256,
        validatedAt: new Date("2026-08-12T08:00:00Z").toISOString(),
    });
    database.saveDescription(recording.id, {
        artifactSha256: sha256,
        promptVersion: "test-v1",
        fps: 2,
        output: { title: "Specific test title", description: "A concrete test description.", tags: ["room"] },
        evidencePath: path.join(directory, "evidence.json"),
    });
    database.saveProvenance(recording.id, {
        observedIdentifier: "alias",
        status: "resolved",
        streamerId: "streamer-id",
        alias: "alias",
        streamerUrl: "https://tango.me/streamer-id",
        aliasUrl: "https://tango.me/alias",
        reason: null,
        updatedAt: new Date("2026-08-12T08:00:00Z").toISOString(),
    });
    database.saveUploadMetadata(recording.id, {
        title: "Specific test title [alias]",
        description: "A concrete test description.",
        tags: ["tango", "live"],
    });
}

async function campaignWorkerFixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-antibot-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const finalizationPath = path.join(root, "finalization.sqlite");
    const authority = new DatabaseSync(finalizationPath);
    authority.exec("CREATE TABLE integrity_checkpoints (recording_path TEXT PRIMARY KEY, playlist_fingerprint TEXT NOT NULL, report_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT");
    const sourcePath = await addFinalized(authority, path.join(root, "tango", "edited"), "2026-08-16 120000 testalias");
    authority.close();
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const inspection = await inspectFinalizedRecording(sourcePath, "tango", "edited");
    assert.equal(inspection.status, "finalized");
    const recording = database.discover(inspection.recording);
    advanceToMetadataReady(database, recording, root);
    const config = { ...pipelineConfig, finalizationDatabasePath: finalizationPath };
    const resolver = TargetCatalogResolver.load({ resolveIdentifier: async () => null });
    return { database, config, resolver, recording, sourcePath };
}

function failingUpload() {
    let calls = 0;
    return {
        calls: () => calls,
        upload: async () => {
            calls++;
            throw new HumanActionRequiredError("captcha", "Friendly Captcha did not complete automatically on the upload page");
        },
    };
}

async function addFinalized(authority, root, folderName) {
    const recordingPath = path.join(root, folderName);
    await mkdir(recordingPath, { recursive: true });
    const playlist = "#EXTM3U\n#EXTINF:1,\n1.ts\n#EXT-X-ENDLIST\n";
    await writeFile(path.join(recordingPath, "playlist.m3u8"), playlist);
    await writeFile(path.join(recordingPath, "1.ts"), "media");
    authority.prepare("INSERT INTO integrity_checkpoints VALUES (?, ?, ?, ?)").run(
        recordingPath,
        createHash("sha256").update(playlist).digest("hex"),
        JSON.stringify({ version: 2, status: "ready" }),
        "2026-08-14T08:00:00.000Z",
    );
    return recordingPath;
}

test("production roots are edited-only while manual remux roots retain downloader access", () => {
    assert.equal(pipelineConfig.discoveryRoots.length, 3);
    assert(pipelineConfig.discoveryRoots.every((root) => root.sourceKind === "edited"));
    assert(pipelineConfig.discoveryRoots.every((root) => root.path.endsWith("edited")));
    assert.equal(pipelineConfig.manualRemuxRoots.filter((root) => root.sourceKind === "downloader").length, 3);
    assert.equal(pipelineConfig.manualRemuxRoots.filter((root) => root.sourceKind === "edited").length, 3);
});

test("capture timestamps are strict and sortable", () => {
    assert.equal(captureKeyFromFolderName("2025-02-03 040506 alias"), "2025-02-03T04:05:06");
    assert.equal(captureKeyFromFolderName("2025-02-30 040506 alias"), null);
    assert.equal(captureKeyFromFolderName("recording"), null);
});

test("campaign selection uses exact ready checkpoints, edited roots, oldest time, and provider filters", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-campaign-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const finalizationPath = path.join(root, "finalization.sqlite");
    const authority = new DatabaseSync(finalizationPath);
    authority.exec(`CREATE TABLE integrity_checkpoints (
        recording_path TEXT PRIMARY KEY,
        playlist_fingerprint TEXT NOT NULL,
        report_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    ) STRICT`);
    const tangoEdited = path.join(root, "tango", "edited");
    const fc2Edited = path.join(root, "fc2", "edited");
    const tangoDownloader = path.join(root, "tango", "downloaded");
    const tangoPath = await addFinalized(authority, tangoEdited, "2025-02-03 040506 tango_alias");
    const fc2Path = await addFinalized(authority, fc2Edited, "2024-01-02 030405 12345");
    await addFinalized(authority, tangoDownloader, "2020-01-01 000000 ignored_raw");
    authority.close();

    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const roots = [
        { provider: "tango", sourceKind: "edited", path: tangoEdited },
        { provider: "fc2", sourceKind: "edited", path: fc2Edited },
    ];
    const oldest = await selectOldestFinalizedEditedCandidate({
        finalizationDatabasePath: finalizationPath,
        roots,
        providerFilter: "all",
        pipelineDatabase: database,
    });
    assert.equal(oldest?.sourcePath, fc2Path);
    database.discover(oldest);
    const next = await selectOldestFinalizedEditedCandidate({
        finalizationDatabasePath: finalizationPath,
        roots,
        providerFilter: "all",
        pipelineDatabase: database,
    });
    assert.equal(next?.sourcePath, tangoPath);
    const emptyDatabase = new PipelineDatabase(":memory:");
    const tangoOnly = await selectOldestFinalizedEditedCandidate({
        finalizationDatabasePath: finalizationPath,
        roots,
        providerFilter: "tango",
        pipelineDatabase: emptyDatabase,
    });
    assert.equal(tangoOnly?.sourcePath, tangoPath);
    emptyDatabase.close();
});

test("antibot failure parks the campaign in a 60s cooldown instead of blocking", async (t) => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    database.setCampaignState("running");
    const fake = failingUpload();
    const worker = new CampaignWorker(database, config, resolver, fake.upload, undefined, "worker-test");
    const result = await worker.step(new Date("2026-08-17T10:00:00Z"));
    assert.equal(result.disposition, "antibot_cooldown");
    assert.equal(result.recordingId, recording.id);
    const control = database.getCampaignControl();
    assert.equal(control.state, "paused");
    assert.equal(control.resumeAt, "2026-08-17T10:01:00.000Z");
    assert.equal(control.antibotFailures, 1);
    assert.equal(database.get(recording.id).state, "metadata_ready");
});

test("cooldown resumes the same recording at resume_at and doubles the wait per failure", async (t) => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    database.setCampaignState("running");
    const fake = failingUpload();
    const worker = new CampaignWorker(database, config, resolver, fake.upload, undefined, "worker-test");
    await worker.step(new Date("2026-08-17T10:00:00Z"));
    const resumed = await worker.step(new Date("2026-08-17T10:01:00Z"));
    assert.equal(resumed.disposition, "antibot_cooldown");
    assert.equal(fake.calls(), 2);
    const control = database.getCampaignControl();
    assert.equal(control.resumeAt, "2026-08-17T10:03:00.000Z");
    assert.equal(control.antibotFailures, 2);
    assert.equal(database.get(recording.id).state, "metadata_ready");
});

test("the XVideos daily upload limit parks the campaign for exactly 24h and resets the antibot streak", async (t) => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    database.setCampaignState("running");
    database.recordAntibotFailure(2, 120_000, new Date("2026-08-17T09:00:00Z"));
    const worker = new CampaignWorker(database, config, resolver, async () => {
        throw new HumanActionRequiredError("daily_limit", "XVideos daily upload limit reached");
    }, undefined, "worker-test");
    database.resumeFromCooldown(new Date("2026-08-17T10:00:00Z"));
    const result = await worker.step(new Date("2026-08-17T10:00:00Z"));
    assert.equal(result.disposition, "daily_limit_cooldown");
    assert.equal(result.resumeAt, "2026-08-18T10:00:00.000Z");
    const control = database.getCampaignControl();
    assert.equal(control.state, "paused");
    assert.equal(control.antibotFailures, 0);
    assert.equal(database.get(recording.id).state, "metadata_ready");
});

test("a successful upload resets the antibot streak", async (t) => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    database.setCampaignState("running");
    const fake = failingUpload();
    let succeeded = false;
    const worker = new CampaignWorker(database, config, resolver, async () => {
        if (!succeeded) {
            succeeded = true;
            throw new HumanActionRequiredError("captcha", "Friendly Captcha did not complete automatically on the upload page");
        }
        return { recordingId: recording.id, state: "xvideos_uncertain", transmittedBytes: 100, confirmAfter: "2026-08-18T10:01:00.000Z" };
    }, undefined, "worker-test");
    await worker.step(new Date("2026-08-17T10:00:00Z"));
    assert.equal(database.getCampaignControl().antibotFailures, 1);
    const resumed = await worker.step(new Date("2026-08-17T10:01:00Z"));
    assert.equal(resumed.disposition, "upload_completed");
    const control = database.getCampaignControl();
    assert.equal(control.antibotFailures, 0);
    assert.equal(control.state, "running");
    assert.equal(control.resumeAt, null);
});

test("campaign intent and limits persist independently of worker lifetime", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-campaign-control-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const databasePath = path.join(root, "pipeline.sqlite");
    const first = new PipelineDatabase(databasePath);
    assert.equal(first.getCampaignControl().state, "paused");
    first.configureCampaign("sc", 123_456_789);
    first.setCampaignState("running");
    first.close();
    const reopened = new PipelineDatabase(databasePath);
    assert.deepEqual({
        state: reopened.getCampaignControl().state,
        provider: reopened.getCampaignControl().providerFilter,
        limit: reopened.getCampaignControl().monthlyUploadLimitBytes,
    }, { state: "running", provider: "sc", limit: 123_456_789 });
    reopened.setCampaignState("paused");
    reopened.close();
});
