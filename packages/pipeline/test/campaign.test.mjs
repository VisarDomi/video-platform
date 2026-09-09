import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { configureCampaign, setCampaignRunning } from "../dist/commands/campaign.js";

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
    database.recordResolutionPolicyAssessment(recording.id, "resolution-policy-v3: test fixture");
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
    const config = { ...pipelineConfig, comparisonTrialOnly: false, finalizationDatabasePath: finalizationPath };
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
    assert.equal(pipelineConfig.stagingRoot, path.join(pipelineConfig.artifactsRoot, "production-v3"));
    assert.equal(pipelineConfig.manualStagingRoot, path.join(pipelineConfig.stagingRoot, "manual"));
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
    const configured = configureCampaign({ ...pipelineConfig, comparisonTrialOnly: false, databasePath }, "all", undefined, 10);
    assert.equal(configured.monthlyUploadLimitBytes, 123_456_789);
    assert.equal(configured.state, "paused");
    assert.equal(configured.trialPerProvider, 10);
});

test("a 30-recording trial stops at ten per provider, persists, and normal resume continues oldest-first", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-campaign-trial-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const finalizationDatabasePath = path.join(root, "finalization.sqlite");
    const authority = new DatabaseSync(finalizationDatabasePath);
    authority.exec("CREATE TABLE integrity_checkpoints (recording_path TEXT PRIMARY KEY, playlist_fingerprint TEXT NOT NULL, report_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT");
    const providers = ["tango", "fc2", "sc"];
    const roots = providers.map((provider) => ({ provider, sourceKind: "edited", path: path.join(root, provider, "edited") }));
    for (const [providerIndex, discoveryRoot] of roots.entries()) {
        for (let index = 1; index <= 11; index++) {
            await addFinalized(authority, discoveryRoot.path, `202${providerIndex}-01-${String(index).padStart(2, "0")} 120000 ${discoveryRoot.provider}`);
        }
    }
    authority.close();
    const databasePath = path.join(root, "pipeline.sqlite");
    let database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    const config = { ...pipelineConfig, comparisonTrialOnly: false, databasePath, finalizationDatabasePath, discoveryRoots: roots, cleanupEnabled: false };
    const resolver = { resolve: async (candidate) => ({
        observedIdentifier: candidate.provider, status: "resolved", streamerId: "streamer", alias: candidate.provider,
        streamerUrl: "https://example.com/streamer", aliasUrl: null, reason: null, updatedAt: new Date().toISOString(),
    }) };
    const uploaded = [];
    const upload = async (id) => {
        uploaded.push(id);
        database.transition(id, "metadata_ready", "xvideos_admitted");
        database.transition(id, "xvideos_admitted", "xvideos_uploading");
        database.transition(id, "xvideos_uploading", "xvideos_uncertain");
        return { state: "xvideos_uncertain" };
    };
    let worker = new CampaignWorker(database, config, resolver, upload);
    const newer = await inspectFinalizedRecording(path.join(roots[0].path, "2020-01-11 120000 tango"), "tango", "edited");
    const queued = database.discover(newer.recording);
    advanceToMetadataReady(database, queued, root);
    database.configureCampaign("all", 1_000_000_000, new Date(), 10);
    assert.equal(database.getCampaignControl().state, "paused");
    database.setCampaignState("running");
    let finished;
    let waitedForVerification = false;
    for (let step = 0; step < 70; step++) {
        const result = await worker.step();
        if (result.disposition === "admitted") advanceToMetadataReady(database, database.get(result.recordingId), root);
        else if (result.disposition === "trial_finished") { finished = result; break; }
        else if (result.disposition === "trial_verification_wait") {
            assert.equal(uploaded.length, 30);
            assert.equal(database.getCampaignControl().state, "running");
            assert.equal(database.getCampaignControl().trialFinishedAt, null);
            waitedForVerification = true;
            for (const id of uploaded) {
                database.transition(id, "xvideos_uncertain", "xvideos_uploaded");
                database.transition(id, "xvideos_uploaded", "xvideos_verified");
                database.transition(id, "xvideos_verified", "cleanup_eligible");
            }
        }
        else assert.equal(result.disposition, "upload_completed");
        if (step === 12) {
            database.setCampaignState("paused");
            database.close();
            database = new PipelineDatabase(databasePath);
            assert.equal(database.getCampaignControl().trialPerProvider, 10);
            database.setCampaignState("running");
            assert.equal(database.getCampaignControl().trialPerProvider, 10);
            worker = new CampaignWorker(database, config, resolver, upload);
        }
    }
    assert(finished);
    assert(waitedForVerification);
    assert.equal(uploaded.length, 30);
    assert.equal(new Set(uploaded).size, 30);
    assert(!uploaded.includes(queued.id));
    assert.deepEqual(finished.trial.map(({ provider, admitted }) => ({ provider, admitted })), providers.map((provider) => ({ provider, admitted: 10 })));
    assert(finished.trial.every((provider) => provider.recordings.every((recording) => recording.state === "cleanup_eligible")));
    assert.equal(database.getCampaignControl().state, "paused");
    assert.equal(database.getCampaignControl().resumeAt, null);
    assert.equal((await worker.step()).disposition, "paused");
    database.setCampaignState("running");
    assert.equal(database.getCampaignControl().trialPerProvider, null);
    const next = await worker.step();
    assert.equal(next.disposition, "upload_completed");
    assert.equal(database.get(next.recordingId).provider, "tango");
    assert.match(database.get(next.recordingId).sourcePath, /2020-01-11/);
});

test("trial slots survive missing sources, limits can be adjusted, and incomplete libraries pause", async (t) => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    const now = new Date();
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
        assert.throws(() => database.configureCampaign("all", 1_000_000_000, now, limit), /positive integer/);
    }
    assert.throws(() => database.configureCampaign("sc", 1_000_000_000, now, 10), /provider all/);
    database.configureCampaign("all", 1_000_000_000, now, 1);
    database.enrollCampaignTrial(recording);
    database.enrollCampaignTrial(recording);
    assert.equal(database.getCampaignTrialProgress()[0].admitted, 1);
    assert.equal(database.campaignTrialAllows("tango"), false);
    database.deleteRecording(recording.id);
    assert.equal(database.campaignTrialAllows("tango"), false);
    assert.equal(database.getCampaignTrialProgress()[0].recordings[0].state, "source_missing");
    database.setCampaignState("running");
    assert.throws(() => database.configureCampaign("all", 1_000_000_000, now, 2), /Pause/);
    const worker = new CampaignWorker(database, { ...config, discoveryRoots: [], cleanupEnabled: false }, resolver);
    assert.equal((await worker.step()).disposition, "trial_attention_required");
    assert.equal(database.getCampaignControl().state, "paused");
    assert.equal(database.getCampaignControl().trialFinishedAt, null);
    database.setCampaignState("running");
    assert.equal(database.getCampaignControl().trialPerProvider, 1);
    database.setCampaignState("paused");
    database.configureCampaign("all", 1_000_000_000, now, 2);
    assert.equal(database.getCampaignTrialProgress()[0].admitted, 1);
    database.configureCampaign("all", 1_000_000_000, now, null);
    assert.equal(database.getCampaignControl().trialPerProvider, null);
});

test("campaign resume performs a pending production rollover and archives retired staging files", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-version-resume-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const databasePath = path.join(root, "pipeline.sqlite");
    const artifactsRoot = path.join(root, "artifacts");
    const stagingRoot = path.join(artifactsRoot, "production-v3");
    await mkdir(artifactsRoot);
    const database = new PipelineDatabase(databasePath);
    const recording = database.discover(inputForRollover(root));
    const artifactPath = path.join(artifactsRoot, `${recording.id}.upscale1080p.mp4`);
    await writeFile(artifactPath, "retired artifact");
    database.saveArtifactVariant(recording.id, "upscale1080p", {
        path: artifactPath,
        sizeBytes: 16,
        sha256: "d".repeat(64),
        validatedAt: "2026-08-30T10:00:00.000Z",
    }, 10, 0);
    const interruptedSource = path.join(artifactsRoot, `${recording.id}.upscale1440p.mp4`);
    database.saveArtifactVariant(recording.id, "upscale1440p", {
        path: interruptedSource,
        sizeBytes: 17,
        sha256: "e".repeat(64),
        validatedAt: "2026-08-30T10:00:00.000Z",
    }, 10, 0);
    const interruptedTarget = path.join(
        artifactsRoot,
        "legacy-production-v1",
        path.basename(interruptedSource),
    );
    await mkdir(path.dirname(interruptedTarget), { recursive: true });
    await writeFile(interruptedTarget, "already archived");
    const orphanPath = path.join(artifactsRoot, "orphaned-old-output.tmp");
    await writeFile(orphanPath, "orphaned old output");
    advanceToMetadataReady(database, recording, root);
    database.configureCampaign("all", 1_000_000_000, new Date(), 10);
    database.enrollCampaignTrial(recording);
    database.close();
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE production_version SET version = 'legacy-production-v1' WHERE id = 1").run();
    raw.close();

    const config = {
        ...pipelineConfig, comparisonTrialOnly: false,
        databasePath,
        artifactsRoot,
        stagingRoot,
        manualStagingRoot: path.join(stagingRoot, "manual"),
    };
    const result = await setCampaignRunning(config, true);
    assert.equal(result.productionVersion, "production-v3");
    assert.equal(result.rollover.rolledOver, true);
    assert.equal(result.rollover.retiredRecordings, 1);
    assert.equal(path.dirname(result.rollover.historySnapshotPath), path.join(root, "history", "legacy-production-v1"));
    const snapshot = new DatabaseSync(result.rollover.historySnapshotPath, { readOnly: true });
    assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(snapshot.prepare("SELECT COUNT(*) AS count FROM descriptions").get().count, 1);
    assert.equal(snapshot.prepare("SELECT title FROM upload_metadata").get().title, "Specific test title [alias]");
    assert.equal(snapshot.prepare("SELECT state FROM campaign_control").get().state, "paused");
    snapshot.close();
    assert.equal(result.rollover.artifactArchival.unversioned.moved, 2);
    assert.equal(result.rollover.artifactArchival.retiredGeneration.alreadyArchived, 2);
    await assert.rejects(access(artifactPath), /ENOENT/);
    await access(path.join(artifactsRoot, "legacy-production-v1", path.basename(artifactPath)));
    await access(path.join(artifactsRoot, "legacy-production-v1", path.basename(orphanPath)));
    await access(interruptedTarget);
    await access(stagingRoot);
    const inspection = new PipelineDatabase(databasePath);
    assert.equal(inspection.getCampaignControl().state, "running");
    assert.equal(inspection.getCampaignControl().trialPerProvider, 10);
    assert(inspection.getCampaignTrialProgress().every((provider) => provider.admitted === 0));
    assert.deepEqual(inspection.list(), []);
    inspection.setCampaignState("paused");
    inspection.close();

    const orphanAfterDatabaseReset = path.join(artifactsRoot, "unversioned-after-reset.tmp");
    await writeFile(orphanAfterDatabaseReset, "not represented in the current database");
    const resumedCurrent = await setCampaignRunning(config, true);
    assert.equal(resumedCurrent.rollover.rolledOver, false);
    assert.equal(resumedCurrent.rollover.historySnapshotPath, null);
    assert.equal(resumedCurrent.rollover.artifactArchival.unversioned.moved, 1);
    await assert.rejects(access(orphanAfterDatabaseReset), /ENOENT/);
    await access(path.join(
        artifactsRoot,
        "legacy-production-v1",
        path.basename(orphanAfterDatabaseReset),
    ));
});

function inputForRollover(directory) {
    const sourcePath = path.join(directory, "2025-01-01 000000 alias");
    return {
        provider: "tango",
        sourceKind: "edited",
        sourcePath,
        playlistPath: path.join(sourcePath, "playlist.m3u8"),
        sourceFingerprint: "rollover-fixture",
        durationSeconds: 10,
    };
}
