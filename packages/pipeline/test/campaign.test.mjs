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
import { HumanActionRequiredError } from "../dist/upload/browserUpload.js";
import { ProviderSessionLostError } from "../dist/upload/providerWarnings.js";
import { campaignStatus, configureCampaign, setCampaignRunning } from "../dist/commands/campaign.js";

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
        streamerUrl: "https://live-a.example/streamer-id",
        aliasUrl: "https://live-a.example/alias",
        reason: null,
        updatedAt: new Date("2026-08-12T08:00:00Z").toISOString(),
    });
    database.saveUploadMetadata(recording.id, {
        title: "Specific test title [alias]",
        description: "A concrete test description.",
        tags: ["live-a", "tennis"],
    });
    database.recordResolutionPolicyAssessment(recording.id, "resolution-policy-v6: test fixture");
}

async function campaignWorkerFixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-antibot-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const finalizationPath = path.join(root, "finalization.sqlite");
    const authority = new DatabaseSync(finalizationPath);
    authority.exec("CREATE TABLE integrity_checkpoints (recording_path TEXT PRIMARY KEY, playlist_fingerprint TEXT NOT NULL, report_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT");
    const sourcePath = await addFinalized(authority, path.join(root, "live-a", "edited"), "2026-08-16 120000 testalias");
    authority.close();
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const inspection = await inspectFinalizedRecording(sourcePath, "live-a", "edited");
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

test("a failed in-flight upload preserves a subsequent manual pause", async t => {
    const { database, config, resolver } = await campaignWorkerFixture(t);
    database.setCampaignState("running");
    const worker = new CampaignWorker(database, { ...config, networkUploadsEnabled: true,
        automaticShortsEnabled: false, discoveryRoots: [] }, resolver, async () => {
        database.setCampaignState("paused");
        throw new ProviderSessionLostError("The destination session is logged out; run `restore-session` to restore it");
    });
    assert.equal((await worker.step()).disposition, "attention_required");
    assert.equal(database.getCampaignControl().state, "paused");
    assert.equal(database.getCampaignControl().attentionReason, null);
});

test("campaign waits for the next daily release and retries without a manual resume", async t => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    const databasePath = path.join(path.dirname(config.finalizationDatabasePath), "pipeline.sqlite");
    const seed = new DatabaseSync(databasePath);
    seed.prepare(`INSERT INTO bandwidth_events
        (recording_id, attempt_id, provider, calendar_month, transmitted_bytes, created_at)
        VALUES ('prior-recording', 'prior-attempt', 'video-host', '2026-11', 250000000000, '2026-11-01T12:00:00Z')`).run();
    seed.close();
    database.configureCampaign("all", 25_000_000_000);
    database.setCampaignState("running");
    let calls = 0;
    const worker = new CampaignWorker(database, { ...config, automaticShortsEnabled: false,
        discoveryRoots: [] }, resolver, async () => { calls++; return {}; });
    const beforeRelease = new Date("2026-11-10T22:59:59.999Z");
    const waiting = await worker.step(beforeRelease);
    assert.equal(waiting.disposition, "upload_quota_wait");
    assert.equal(waiting.budget.releasedBytes, 250_000_000_000);
    assert.equal(waiting.budget.remainingBytes, 0);
    assert.equal(calls, 0);
    assert.equal(database.get(recording.id).state, "metadata_ready");
    assert.equal(database.getCampaignControl().state, "running");
    const status = campaignStatus({ ...config, databasePath }, beforeRelease);
    assert.equal(status.uploadBudget.uplink, "home");
    assert.equal(status.uploadBudget.spentBytes, 250_000_000_000);
    assert.equal(status.uploadBudget.releasedBytes, 250_000_000_000);
    assert.equal((await worker.step(new Date("2026-11-10T23:00:00Z"))).disposition, "upload_completed");
    assert.equal(calls, 1);
    assert.equal(database.getCampaignControl().state, "running");
});

test("provider policy block is manual review, not reported as an upload or retried next step", async t => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    database.setCampaignState("running");
    let calls = 0;
    const worker = new CampaignWorker(database, config, resolver, async id => {
        calls++;
        database.transition(id, "metadata_ready", "blocked", "video-host: blocked_too_large; 10000000000-byte maximum");
        return { state: "blocked" };
    });
    const first = await worker.step();
    assert.equal(first.disposition, "attention_required");
    assert.match(first.reason, /video-host: blocked_too_large/);
    assert.equal(database.get(recording.id).state, "blocked");
    await worker.step();
    assert.equal(calls, 1);
});

async function addFinalized(authority, root, folderName) {
    const recordingPath = path.join(root, folderName);
    await mkdir(recordingPath, { recursive: true });
    const playlist = "#EXTM3U\n#EXTINF:180,\n1.ts\n#EXT-X-ENDLIST\n";
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
    assert.equal(pipelineConfig.stagingRoot, path.join(pipelineConfig.artifactsRoot, "production-v6"));
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
    const liveAEdited = path.join(root, "live-a", "edited");
    const liveBEdited = path.join(root, "live-b", "edited");
    const liveADownloader = path.join(root, "live-a", "downloaded");
    const liveAPath = await addFinalized(authority, liveAEdited, "2025-02-03 040506 live_a_alias");
    const liveBPath = await addFinalized(authority, liveBEdited, "2024-01-02 030405 12345");
    await addFinalized(authority, liveADownloader, "2020-01-01 000000 ignored_raw");
    authority.close();

    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const roots = [
        { provider: "live-a", sourceKind: "edited", path: liveAEdited },
        { provider: "live-b", sourceKind: "edited", path: liveBEdited },
    ];
    const oldest = await selectOldestFinalizedEditedCandidate({
        finalizationDatabasePath: finalizationPath,
        roots,
        providerFilter: "all",
        pipelineDatabase: database,
    });
    assert.equal(oldest?.sourcePath, liveBPath);
    database.discover(oldest);
    const next = await selectOldestFinalizedEditedCandidate({
        finalizationDatabasePath: finalizationPath,
        roots,
        providerFilter: "all",
        pipelineDatabase: database,
    });
    assert.equal(next?.sourcePath, liveAPath);
    const emptyDatabase = new PipelineDatabase(":memory:");
    const liveAOnly = await selectOldestFinalizedEditedCandidate({
        finalizationDatabasePath: finalizationPath,
        roots,
        providerFilter: "live-a",
        pipelineDatabase: emptyDatabase,
    });
    assert.equal(liveAOnly?.sourcePath, liveAPath);
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

test("a generic pre-transfer failure retries in 15 minutes, doubling per failure; a login error waits a day; neither overrides a manual pause", async (t) => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    // A page timeout before anything was sent: no video exists, so retry soon.
    database.setCampaignState("running");
    let calls = 0;
    const timeout = new CampaignWorker(database, config, resolver, async () => {calls++; throw new Error("page.goto: Timeout 30000ms exceeded.");});
    await timeout.step(new Date("2026-10-01T00:00:00Z"));
    assert.equal(database.getCampaignControl().resumeAt, "2026-10-01T00:15:00.000Z");
    assert.equal(database.get(recording.id).state, "metadata_ready");
    await timeout.step(new Date("2026-10-01T00:10:00Z"));
    assert.equal(calls, 1);
    await timeout.step(new Date("2026-10-01T00:15:00Z"));
    assert.equal(calls, 2);
    assert.equal(database.getCampaignControl().resumeAt, "2026-10-01T00:45:00.000Z", "the second failure in a row waits 30 minutes");
    database.setCampaignState("paused");
    await timeout.step(new Date("2026-10-04T00:00:00Z"));
    assert.equal(calls, 2);

    // A login problem is not retried quickly.
    database.resetAntibotFailures();
    database.setCampaignState("running");
    const login = new CampaignWorker(database, config, resolver, async () => {calls++; throw new HumanActionRequiredError("session_login", "OAuth timeout");});
    await login.step(new Date("2026-10-05T00:00:00Z"));
    assert.equal(database.getCampaignControl().resumeAt, "2026-10-06T00:00:00.000Z");
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

test("the video-host daily upload limit parks the campaign for exactly 24h and resets the antibot streak", async (t) => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    database.setCampaignState("running");
    database.recordAntibotFailure(2, 120_000, new Date("2026-08-17T09:00:00Z"));
    const worker = new CampaignWorker(database, config, resolver, async () => {
        throw new HumanActionRequiredError("daily_limit", "video-host daily upload limit reached");
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
        return { recordingId: recording.id, state: "upload_uncertain", transmittedBytes: 100, confirmAfter: "2026-08-18T10:01:00.000Z" };
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
    first.configureCampaign("live-c", 123_456_789);
    first.setCampaignState("running");
    first.close();
    const reopened = new PipelineDatabase(databasePath);
    assert.deepEqual({
        state: reopened.getCampaignControl().state,
        provider: reopened.getCampaignControl().providerFilter,
        limit: reopened.getCampaignControl().dailyUploadLimitBytes,
    }, { state: "running", provider: "live-c", limit: 123_456_789 });
    reopened.setCampaignState("paused");
    reopened.close();
    const configured = configureCampaign({ ...pipelineConfig, comparisonTrialOnly: false, databasePath }, "all", undefined, 10);
    assert.equal(configured.dailyUploadLimitBytes, 123_456_789);
    assert.equal(configured.state, "paused");
    assert.equal(configured.trialPerProvider, 10);
});

test("a 30-recording trial stops at ten per provider, persists, and normal resume continues oldest-first", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-campaign-trial-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const finalizationDatabasePath = path.join(root, "finalization.sqlite");
    const authority = new DatabaseSync(finalizationDatabasePath);
    authority.exec("CREATE TABLE integrity_checkpoints (recording_path TEXT PRIMARY KEY, playlist_fingerprint TEXT NOT NULL, report_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT");
    const providers = ["live-a", "live-b", "live-c"];
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
        database.transition(id, "metadata_ready", "upload_admitted");
        database.transition(id, "upload_admitted", "uploading");
        database.transition(id, "uploading", "upload_uncertain");
        return { state: "upload_uncertain" };
    };
    let worker = new CampaignWorker(database, config, resolver, upload);
    const newer = await inspectFinalizedRecording(path.join(roots[0].path, "2020-01-11 120000 live-a"), "live-a", "edited");
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
                database.transition(id, "upload_uncertain", "uploaded");
                database.transition(id, "uploaded", "upload_verified");
                database.transition(id, "upload_verified", "cleanup_eligible");
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
    assert.equal(database.get(next.recordingId).provider, "live-a");
    assert.match(database.get(next.recordingId).sourcePath, /2020-01-11/);
});

test("trial slots survive missing sources, limits can be adjusted, and incomplete libraries pause", async (t) => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    const now = new Date();
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
        assert.throws(() => database.configureCampaign("all", 1_000_000_000, now, limit), /positive integer/);
    }
    assert.throws(() => database.configureCampaign("live-c", 1_000_000_000, now, 10), /provider all/);
    database.configureCampaign("all", 1_000_000_000, now, 1);
    database.enrollCampaignTrial(recording);
    database.enrollCampaignTrial(recording);
    assert.equal(database.getCampaignTrialProgress(["live-a", "live-b", "live-c"])[0].admitted, 1);
    assert.equal(database.campaignTrialAllows("live-a"), false);
    database.setLocalSourcePresence(recording.id, 'missing', 'user removed source');
    await rm(recording.sourcePath, {recursive:true,force:true});
    assert.equal(database.campaignTrialAllows("live-a"), false);
    assert.equal(database.getCampaignTrialProgress(["live-a", "live-b", "live-c"])[0].recordings[0].state, "source_missing");
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
    assert.equal(database.getCampaignTrialProgress(["live-a", "live-b", "live-c"])[0].admitted, 1);
    database.configureCampaign("all", 1_000_000_000, now, null);
    assert.equal(database.getCampaignControl().trialPerProvider, null);
});

test("campaign resume performs a pending production rollover and archives retired staging files", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-version-resume-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const databasePath = path.join(root, "pipeline.sqlite");
    const artifactsRoot = path.join(root, "artifacts");
    const stagingRoot = path.join(artifactsRoot, "production-v6");
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
    assert.equal(result.productionVersion, "production-v6");
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
    assert(inspection.getCampaignTrialProgress(["live-a", "live-b", "live-c"]).every((provider) => provider.admitted === 0));
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
        provider: "live-a",
        sourceKind: "edited",
        sourcePath,
        playlistPath: path.join(sourcePath, "playlist.m3u8"),
        sourceFingerprint: "rollover-fixture",
        durationSeconds: 10,
    };
}

test("browser launch failures use the 15-minute transport cooldown, retaining the real diagnostic", async t => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    database.setCampaignState('running');
    // What a destination's uploader throws when its browser cannot start: nothing was sent.
    const worker = new CampaignWorker(database,config,resolver,
        async()=>{throw new Error('Browser launch failed after two attempts: profile owner still closing');});
    const result=await worker.step(new Date('2026-11-02T00:00:00Z'));
    assert.equal(result.disposition,'upload_retry_cooldown');
    assert.equal(result.resumeAt,'2026-11-02T00:15:00.000Z');
    assert.match(result.reason,/profile owner still closing/);
    assert.equal(database.get(recording.id).state,'metadata_ready');
});

test("a local stage waiting for a resource holds only its recording: a prepared upload still goes ahead", async (t) => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    // An older recording whose next stage has to wait (a disk trim, a model that would not start).
    const root = path.dirname(path.dirname(path.dirname(recording.sourcePath)));
    const authority = new DatabaseSync(config.finalizationDatabasePath);
    const olderPath = await addFinalized(authority, path.join(root, "live-a", "edited"), "2026-08-16 110000 olderalias");
    authority.close();
    const older = database.discover((await inspectFinalizedRecording(olderPath, "live-a", "edited")).recording);
    database.setCampaignState("running");
    const uploads = [];
    const worker = new CampaignWorker(database, config, resolver, async id => { uploads.push(id); throw new HumanActionRequiredError("captcha", "fixture"); },
        undefined, "worker-test");
    const { StageDeferredError } = await import("../dist/scheduler/orchestrator.js");
    worker.orchestrator = { processRecording: async id => { assert.equal(id, older.id); throw new StageDeferredError("waiting for fstrim to finish trimming the disk before starting the descriptor"); } };
    const step = await worker.step(new Date("2026-08-17T10:00:00Z"));
    assert.deepEqual(uploads, [recording.id], "the prepared upload went ahead");
    assert.equal(step.recordingId, recording.id);
    // With nothing to upload, the wait is the step's outcome and nothing new is admitted.
    database.transition(recording.id, "metadata_ready", "blocked", "fixture: out of the way");
    database.setCampaignState("running");
    const waiting = await worker.step(new Date("2026-08-17T10:05:00Z"));
    assert.equal(waiting.disposition, "resource_wait");
    assert.equal(waiting.recordingId, older.id);
    assert.match(waiting.reason, /fstrim/);
});

test("already-discovered recordings missing provenance resolve on demand instead of entering provenance_review_required", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-missing-prov-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const finalizationPath = path.join(root, "finalization.sqlite");
    const authority = new DatabaseSync(finalizationPath);
    authority.exec("CREATE TABLE integrity_checkpoints (recording_path TEXT PRIMARY KEY, playlist_fingerprint TEXT NOT NULL, report_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT");
    const sourcePath = await addFinalized(authority, path.join(root, "live-b", "edited"), "2026-01-23 150039 990001");
    authority.close();
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const inspection = await inspectFinalizedRecording(sourcePath, "live-b", "edited");
    assert.equal(inspection.status, "finalized");
    const recording = database.discover(inspection.recording);
    database.transition(recording.id, "server_ready", "remuxed");
    const sha256 = "b".repeat(64);
    database.saveArtifact(recording.id, { path: path.join(root, recording.id + ".mp4"), sizeBytes: 1_000, sha256, validatedAt: "2026-08-12T08:00:00Z" });
    database.saveDescription(recording.id, {
        artifactSha256: sha256, promptVersion: "test-v1", fps: 2,
        output: { title: "Fixture title", description: "Fixture description.", tags: [] },
        evidencePath: path.join(root, "evidence.json"),
    });
    database.recordResolutionPolicyAssessment(recording.id, "resolution-policy-v6: test fixture");
    assert.equal(database.getProvenance(recording.id), null, "precondition: no provenance row (like retired-destination re-entry)");
    database.setCampaignState("running");
    const resolver = TargetCatalogResolver.load({
        resolveIdentifier: async (provider, identifier) => ({
            id: identifier, label: identifier, channelUrl: `https://${provider}.example/${identifier}/`, aliasUrl: null,
        }),
    });
    const config = { ...pipelineConfig, comparisonTrialOnly: false, automaticShortsEnabled: false,
        finalizationDatabasePath: finalizationPath, discoveryRoots: [] };
    const worker = new CampaignWorker(database, config, resolver);
    const step = await worker.step(new Date("2026-11-25T03:00:00Z"));
    assert.equal(step.disposition, "stage_completed");
    assert.equal(step.recordingId, recording.id);
    assert.equal(step.state, "metadata_ready");
    assert.equal(database.getProvenance(recording.id)?.status, "resolved");
});

test("prepare runs one named recording through the local stages to ready, never uploading, and leaves the rest alone", async (t) => {
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    const root = path.dirname(path.dirname(path.dirname(recording.sourcePath)));
    const authority = new DatabaseSync(config.finalizationDatabasePath);
    const olderPath = await addFinalized(authority, path.join(root, "live-a", "edited"), "2026-08-16 110000 olderalias");
    const namedPath = await addFinalized(authority, path.join(root, "live-a", "edited"), "2026-08-16 130000 namedalias");
    authority.close();
    const older = database.discover((await inspectFinalizedRecording(olderPath, "live-a", "edited")).recording);
    const named = database.discover((await inspectFinalizedRecording(namedPath, "live-a", "edited")).recording);
    const uploads = [];
    const worker = new CampaignWorker(database, config, resolver, async id => { uploads.push(id); }, undefined, "worker-test");
    const processed = [];
    worker.orchestrator = { processRecording: async id => {
        processed.push(id);
        // Each call is one stage, as the orchestrator's are.
        database.transition(id, "server_ready", "blocked", "fixture: stood in for the stages");
        database.transition(id, "blocked", "metadata_ready", "fixture");
        return database.get(id);
    } };
    const result = await worker.prepare(named.id);
    assert.equal(result.state, "metadata_ready");
    assert.deepEqual(processed, [named.id], "only the named recording, though an older one waits");
    assert.deepEqual(uploads, [], "prepare uploads nothing");
    assert.equal(database.get(older.id).state, "server_ready");
    assert.ok(database.getProvenance(named.id), "provenance resolved before the stages");
    // Already past the local stages: nothing runs.
    assert.equal((await worker.prepare(recording.id)).state, "metadata_ready");
    assert.deepEqual(processed, [named.id]);
});

// Last in this file: a service stop cannot be undone in its process.
test("an upload a service stop aborts waits for the next start: no failure streak, no cooldown", async t => {
    const { markStopping } = await import("../dist/shutdown.js");
    const { UploadCoordinator } = await import("../dist/upload/uploadCoordinator.js");
    const { database, config, resolver, recording } = await campaignWorkerFixture(t);
    database.setCampaignState("running");
    const now = new Date("2026-11-26T03:02:02Z");
    // What a deploy's stop does to a transfer in flight: the stop signal aborts its request.
    const worker = new CampaignWorker(database, config, resolver, async (id) => {
        const reservation = database.reserveUpload(id, 1_000, now);
        await new UploadCoordinator(database, { async upload() {
            markStopping();
            throw new DOMException("This operation was aborted", "AbortError");
        } }).uploadAdmitted(id, reservation, { recordingId: id, artifactPath: "/nonexistent.mp4", sizeBytes: 1_000,
            title: "t", description: "d", tags: [], visibility: "private" }, now);
    });
    const result = await worker.step(now);
    assert.equal(result.disposition, "resource_wait");
    assert.match(result.reason, /interrupted by a service stop/);
    const control = database.getCampaignControl();
    assert.equal(control.state, "running");
    assert.equal(control.resumeAt, null);
    assert.equal(control.antibotFailures, 0);
    assert.equal(database.get(recording.id).state, "metadata_ready");
    assert.equal(database.canAttemptUpload(recording.id, new Date(now.getTime() + 60_000)), true);
    const ledger = new DatabaseSync(path.join(path.dirname(config.finalizationDatabasePath), "pipeline.sqlite"), { readOnly: true });
    const attempt = ledger.prepare("SELECT status, error FROM upload_attempts WHERE recording_id = ?").get(recording.id);
    ledger.close();
    assert.equal(attempt.status, "failed");
    assert.match(attempt.error, /^interrupted by a service stop: This operation was aborted/);
});
