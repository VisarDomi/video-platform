import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PipelineDatabase, calendarMonth } from "../dist/db/pipelineDatabase.js";
import { createDryRunUploadPlan } from "../dist/upload/dryRunPlan.js";
import { PipelineOrchestrator } from "../dist/scheduler/orchestrator.js";
import { UploadCoordinator, UploadTransportError } from "../dist/upload/uploadCoordinator.js";

async function databaseFixture(t, closeAfter = true) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-pipeline-db-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const databasePath = path.join(directory, "pipeline.sqlite");
    const database = new PipelineDatabase(databasePath);
    if (closeAfter) t.after(() => database.close());
    return { database, databasePath, directory };
}

function input(directory, suffix = "one") {
    const sourcePath = path.join(directory, suffix);
    return {
        provider: "tango",
        sourceKind: "edited",
        sourcePath,
        playlistPath: path.join(sourcePath, "playlist.m3u8"),
        sourceFingerprint: `fingerprint-${suffix}`,
        durationSeconds: 600,
    };
}

function advanceToRemuxed(database, id) {
    database.transition(id, "server_ready", "remuxed");
}

function advanceToMetadataReady(database, recording, directory, sizeBytes = 1_000) {
    advanceToRemuxed(database, recording.id);
    const sha256 = "a".repeat(64);
    database.saveArtifact(recording.id, {
        path: path.join(directory, `${recording.id}.mp4`),
        sizeBytes,
        sha256,
        validatedAt: new Date("2026-08-12T08:00:00Z").toISOString(),
    });
    database.saveDescription(recording.id, {
        artifactSha256: sha256,
        promptVersion: "test-v1",
        fps: 2,
        output: { title: "Specific test title", description: "A concrete test description for metadata.", tags: ["room", "standing"] },
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
        title: `Specific test title [${path.basename(directory)}]`,
        description: "A concrete test description.\n\nRecorded: unknown\nSource: https://tango.me/streamer-id",
        tags: ["tango", "live", "room"],
    });
    database.recordResolutionPolicyAssessment(recording.id, "resolution-policy-v3: test fixture");
    return database.get(recording.id);
}

test("schema initialization is idempotent and discovery deduplicates across restarts", async (t) => {
    const { database, databasePath, directory } = await databaseFixture(t, false);
    const first = database.discover(input(directory));
    const second = database.discover(input(directory));
    assert.equal(first.id, second.id);
    assert.equal(database.list().length, 1);
    assert.equal(database.getProductionVersion(), "production-v3");
    assert.equal(database.integrityCheck(), "ok");

    database.close();
    const reopened = new PipelineDatabase(databasePath);
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.integrityCheck(), "ok");
    reopened.close();
});

test("schema eight gains trial controls without changing generation, history, or campaign intent", async (t) => {
    const { database, databasePath, directory } = await databaseFixture(t, false);
    const recording = database.discover(input(directory));
    database.configureCampaign("sc", 123_456_789);
    database.close();
    const old = new DatabaseSync(databasePath);
    old.exec(`ALTER TABLE campaign_control DROP COLUMN trial_per_provider;
        ALTER TABLE campaign_control DROP COLUMN trial_finished_at;
        DROP TABLE campaign_trial_recordings;
        UPDATE schema_version SET version = 8;`);
    old.close();
    const migrated = new PipelineDatabase(databasePath);
    t.after(() => migrated.close());
    assert.equal(migrated.getProductionVersion(), "production-v3");
    assert.equal(migrated.get(recording.id).state, "server_ready");
    assert.equal(migrated.getCampaignControl().state, "paused");
    assert.equal(migrated.getCampaignControl().providerFilter, "sc");
    assert.equal(migrated.getCampaignControl().monthlyUploadLimitBytes, 123_456_789);
    assert.equal(migrated.getCampaignControl().trialPerProvider, null);
    assert.equal(migrated.getCampaignControl().trialFinishedAt, null);
    assert(migrated.getCampaignTrialProgress().every((provider) => provider.admitted === 0));
});

test("schema six migrates remote uploads and marks the old production generation for rollover", async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-pipeline-v6-migration-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const databasePath = path.join(directory, "pipeline.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE schema_version (version INTEGER NOT NULL) STRICT;
        INSERT INTO schema_version VALUES (6);
        CREATE TABLE recordings (
            id TEXT PRIMARY KEY, provider TEXT NOT NULL, source_kind TEXT NOT NULL,
            source_path TEXT NOT NULL UNIQUE, playlist_path TEXT NOT NULL,
            source_fingerprint TEXT NOT NULL, duration_seconds REAL NOT NULL,
            state TEXT NOT NULL, block_reason TEXT, lease_owner TEXT,
            lease_expires_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE remote_uploads (
            recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
            attempt_id TEXT NOT NULL, remote_id TEXT NOT NULL,
            remote_url TEXT NOT NULL, verified_at TEXT NOT NULL
        ) STRICT;
    `);
    legacy.close();

    const migrated = new PipelineDatabase(databasePath);
    assert.equal(migrated.integrityCheck(), "ok");
    migrated.close();
    const inspection = new DatabaseSync(databasePath);
    assert.equal(inspection.prepare("SELECT version FROM schema_version").get().version, 10);
    assert.equal(inspection.prepare("SELECT version FROM production_version").get().version, "legacy-production-v1");
    const columns = inspection.prepare("PRAGMA table_info(remote_uploads)").all().map((column) => column.name);
    assert(columns.includes("artifact_part"));
    inspection.close();
});

test("production rollover retires workflow state while preserving quota, overrides, and campaign configuration", async (t) => {
    const { database, databasePath, directory } = await databaseFixture(t, false);
    const recording = database.discover(input(directory));
    advanceToMetadataReady(database, recording, directory, 1_000);
    database.saveManualProvenance(recording.id, {
        observedIdentifier: "alias",
        streamerId: "manual-id",
        alias: "alias",
        streamerUrl: "https://example.test/manual-id",
    });
    database.configureCampaign("sc", 123_456_789);
    const now = new Date("2026-08-30T10:00:00Z");
    const reservation = database.reserveUpload(recording.id, 1_000, now);
    const attempt = database.beginUpload(recording.id, reservation, now);
    database.finishUploadAttempt(attempt, {
        status: "accepted",
        transmittedBytes: 900,
        remoteId: "old-remote",
        remoteUrl: "https://example.test/old-remote",
    }, now);
    database.markRemoteVerified(recording.id, "old-remote", "https://example.test/old-remote", now);
    database.close();

    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE production_version SET version = 'legacy-production-v1' WHERE id = 1").run();
    raw.close();
    const reopened = new PipelineDatabase(databasePath);
    const plan = reopened.planProductionRollover();
    assert.equal(plan.required, true);
    assert.equal(plan.recordingCount, 1);
    assert.equal(plan.remoteUploadCount, 1);
    const leased = reopened.claimRecording(
        recording.id,
        ["xvideos_verified"],
        "still-running-old-worker",
        60_000,
    );
    assert.equal(leased?.id, recording.id);
    assert.equal(reopened.planProductionRollover().leasedRecordingCount, 1);
    assert.throws(() => reopened.commitProductionRollover(), /refuses 1 leased recording/);
    reopened.releaseLease(recording.id, "still-running-old-worker");
    assert.equal(plan.preservedBandwidthBytes, 900);
    assert(plan.ownedPaths.includes(path.resolve(path.join(directory, `${recording.id}.mp4`))));

    const rollover = reopened.commitProductionRollover();
    assert.equal(rollover.rolledOver, true);
    assert.equal(reopened.getProductionVersion(), "production-v3");
    assert.deepEqual(reopened.list(), []);
    assert.deepEqual(reopened.uploadUsage("2026-08"), { spent: 900, reserved: 0 });
    assert.equal(reopened.getProvenanceOverride("tango", "alias")?.streamerId, "manual-id");
    assert.equal(reopened.getCampaignControl().providerFilter, "sc");
    assert.equal(reopened.getCampaignControl().monthlyUploadLimitBytes, 123_456_789);
    assert.deepEqual(reopened.listProductionRollovers().map((row) => ({
        fromVersion: row.fromVersion,
        toVersion: row.toVersion,
        retiredRecordings: row.retiredRecordings,
        retiredRemoteUploads: row.retiredRemoteUploads,
    })), [{
        fromVersion: "legacy-production-v1",
        toVersion: "production-v3",
        retiredRecordings: 1,
        retiredRemoteUploads: 1,
    }]);
    assert.equal(reopened.commitProductionRollover().rolledOver, false);
    reopened.close();
    const archive = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(archive.prepare("SELECT COUNT(*) AS count FROM retired_recordings").get().count, 1);
    assert.equal(archive.prepare("SELECT COUNT(*) AS count FROM retired_upload_attempts").get().count, 1);
    assert.equal(archive.prepare("SELECT COUNT(*) AS count FROM retired_remote_uploads").get().count, 1);
    archive.close();
});

test("production rollover refuses an upload that is still in flight", async (t) => {
    const { database, databasePath, directory } = await databaseFixture(t, false);
    const recording = database.discover(input(directory));
    advanceToMetadataReady(database, recording, directory, 1_000);
    const now = new Date("2026-08-30T10:00:00Z");
    const reservation = database.reserveUpload(recording.id, 1_000, now);
    const attempt = database.beginUpload(recording.id, reservation, now);
    database.close();
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE production_version SET version = 'legacy-production-v1' WHERE id = 1").run();
    raw.close();

    const reopened = new PipelineDatabase(databasePath);
    assert.equal(reopened.planProductionRollover().activeUploadCount, 1);
    assert.throws(() => reopened.commitProductionRollover(), /1 active upload/);
    reopened.finishUploadAttempt(attempt, {
        status: "failed",
        transmittedBytes: 0,
        error: "test stopped before rollover",
    }, now);
    assert.equal(reopened.commitProductionRollover().rolledOver, true);
    reopened.close();
});

test("changed source fingerprints block downstream reuse", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    const changed = database.discover({ ...input(directory), sourceFingerprint: "changed" });
    assert.equal(changed.state, "blocked");
    assert.match(changed.blockReason, /source changed/);
});

test("leases prevent duplicate claims and expired leases are recoverable", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    const now = new Date("2026-08-12T08:00:00Z");
    assert.equal(database.claimNext(["server_ready"], "worker-a", 1_000, now)?.id, recording.id);
    assert.equal(database.claimNext(["server_ready"], "worker-b", 1_000, now), null);
    assert.equal(
        database.claimNext(["server_ready"], "worker-b", 1_000, new Date(now.getTime() + 1_001))?.id,
        recording.id,
    );
    assert.throws(() => database.releaseLease(recording.id, "worker-a"), /not owned/);
    database.releaseLease(recording.id, "worker-b");
});

test("state transitions cannot skip, reverse, or double-complete stages", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    assert.throws(() => database.transition(recording.id, "server_ready", "described"), /Invalid pipeline transition/);
    database.transition(recording.id, "server_ready", "remuxed");
    assert.throws(() => database.transition(recording.id, "server_ready", "remuxed"), /expected state/);
    assert.throws(() => database.transition(recording.id, "remuxed", "server_ready"), /Invalid pipeline transition/);
});

test("description evidence must name the exact validated artifact hash", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToRemuxed(database, recording.id);
    database.saveArtifact(recording.id, {
        path: path.join(directory, "artifact.mp4"),
        sizeBytes: 100,
        sha256: "b".repeat(64),
        validatedAt: new Date().toISOString(),
    });
    assert.throws(() => database.saveDescription(recording.id, {
        artifactSha256: "c".repeat(64),
        promptVersion: "test",
        fps: 1,
        output: {},
        evidencePath: path.join(directory, "evidence.json"),
    }), /does not match/);
    assert.equal(database.get(recording.id)?.state, "artifact_valid");
});

test("named artifact variants coexist without changing canonical state or artifact", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    assert.equal(recording.state, "server_ready");
    const variant = database.saveArtifactVariant(recording.id, "upscale1080p", {
        path: path.join(directory, `${recording.id}.upscale1080p.mp4`),
        sizeBytes: 2_000,
        sha256: "d".repeat(64),
        validatedAt: new Date("2026-08-28T08:00:00Z").toISOString(),
    }, 300, 10);
    assert.equal(variant.variant, "upscale1080p");
    assert.equal(variant.sourceFrameCount, 300);
    assert.equal(variant.droppedSourceFrames, 10);
    assert.equal(database.getArtifact(recording.id), null);
    assert.equal(database.get(recording.id)?.state, "server_ready");
    assert.deepEqual(database.listArtifactVariants(recording.id), [variant]);
    assert.throws(() => database.saveArtifactVariant(recording.id, "upscale1440p", {
        path: path.join(directory, `${recording.id}.upscale1440p.mp4`),
        sizeBytes: 2_000,
        sha256: "e".repeat(64),
        validatedAt: new Date().toISOString(),
    }, 10, 10), /valid source and dropped frame counts/);
});

test("monthly quota reserves atomically, counts retries, and rolls over by timezone", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const first = database.discover(input(directory, "one"));
    const second = database.discover(input(directory, "two"));
    advanceToMetadataReady(database, first, directory, 600);
    advanceToMetadataReady(database, second, directory, 500);
    const now = new Date("2026-08-12T08:00:00Z");
    const firstReservation = database.reserveUpload(first.id, 600, now, "Europe/Tirane", 1_000);
    assert.throws(() => database.reserveUpload(second.id, 500, now, "Europe/Tirane", 1_000), /limit exceeded/);
    const attempt = database.beginUpload(first.id, firstReservation, now);
    database.finishUploadAttempt(attempt, {
        status: "failed",
        transmittedBytes: 250,
        error: "connection reset",
    }, now);
    assert.deepEqual(database.uploadUsage("2026-08"), { spent: 250, reserved: 0 });
    assert.throws(() => database.reserveUpload(first.id, 800, now, "Europe/Tirane", 1_000), /limit exceeded/);
    assert.equal(calendarMonth(new Date("2026-08-31T22:30:00Z"), "Europe/Tirane"), "2026-09");
    assert(database.canReserve(800, new Date("2026-09-01T08:00:00Z"), "Europe/Tirane", 1_000));
});

test("accepted uploads require remote identity and preserve exact byte accounting", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToMetadataReady(database, recording, directory, 1_000);
    const now = new Date("2026-08-12T08:00:00Z");
    const reservation = database.reserveUpload(recording.id, 1_000, now);
    const attempt = database.beginUpload(recording.id, reservation, now);
    assert.throws(() => database.finishUploadAttempt(attempt, {
        status: "accepted",
        transmittedBytes: 1_000,
    }, now), /requires remoteId/);
    const result = database.finishUploadAttempt(attempt, {
        status: "accepted",
        transmittedBytes: 1_000,
        remoteId: "remote-1",
        remoteUrl: "https://example.invalid/video/remote-1",
    }, now);
    assert.equal(result.state, "xvideos_uploaded");
    assert.deepEqual(database.uploadUsage("2026-08"), { spent: 1_000, reserved: 0 });
    assert.throws(() => database.markRemoteVerified(
        recording.id,
        "wrong",
        "https://example.invalid/video/wrong",
    ), /does not match/);
    assert.equal(database.markRemoteVerified(
        recording.id,
        "remote-1",
        "https://example.invalid/video/remote-1",
    ).state, "xvideos_verified");
});

test("uncertain remote acceptance requires reconciliation instead of blind retry", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToMetadataReady(database, recording, directory, 500);
    const now = new Date("2026-08-12T08:00:00Z");
    const reservation = database.reserveUpload(recording.id, 500, now);
    const attempt = database.beginUpload(recording.id, reservation, now);
    assert.equal(database.finishUploadAttempt(attempt, {
        status: "uncertain",
        transmittedBytes: 500,
        error: "response lost after request body was sent",
        confirmation: { confirmAfter: new Date(now.getTime() + 86_400_000) },
    }, now).state, "xvideos_uncertain");
    assert.equal(database.claimNext(["described"], "retry-worker", 1_000, now), null);
    assert.equal(database.reconcileUncertain(
        attempt,
        "remote-uncertain",
        "https://example.invalid/video/remote-uncertain",
        now,
    ).state, "xvideos_uploaded");
    assert.deepEqual(database.uploadUsage("2026-08"), { spent: 500, reserved: 0 });
});

test("dry-run plans are deterministic and mutate neither state nor quota", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToMetadataReady(database, recording, directory, 400);
    const before = database.get(recording.id);
    const first = createDryRunUploadPlan(database, new Date("2026-08-12T08:00:00Z"), "Europe/Tirane", 1_000);
    const second = createDryRunUploadPlan(database, new Date("2026-08-12T08:00:00Z"), "Europe/Tirane", 1_000);
    assert.deepEqual(first, second);
    assert.equal(first[0].disposition, "would_upload");
    const wrongGeneration = createDryRunUploadPlan(
        database,
        new Date("2026-08-12T08:00:00Z"),
        "Europe/Tirane",
        1_000,
        path.join(directory, "production-v3"),
    );
    assert.equal(wrongGeneration[0].reason, "artifact_generation_mismatch");
    assert.deepEqual(database.uploadUsage("2026-08"), { spent: 0, reserved: 0 });
    assert.deepEqual(database.get(recording.id), before);
});

test("the orchestrator resumes one durable stage at a time", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    const calls = [];
    const artifactPath = path.join(directory, "artifact.mp4");
    const artifactHash = "f".repeat(64);
    const stages = {
        async remux() { calls.push("remux"); return artifactPath; },
        async validateArtifact() {
            calls.push("validate");
            return {
                path: artifactPath,
                sizeBytes: 100,
                sha256: artifactHash,
                validatedAt: new Date().toISOString(),
            };
        },
        async describe() {
            calls.push("describe");
            return {
                artifactSha256: artifactHash,
                promptVersion: "test-v1",
                fps: 2,
                output: { title: "Test" },
                evidencePath: path.join(directory, "evidence.json"),
            };
        },
    };
    const orchestrator = new PipelineOrchestrator(database, stages, "worker-test");
    for (let index = 0; index < 3; index++) await orchestrator.processOne();
    assert.deepEqual(calls, ["remux", "validate", "describe"]);
    assert.equal(database.get(recording.id)?.state, "described");
    assert.equal(database.get(recording.id)?.leaseOwner, null);
});

test("the production orchestrator ignores downloader recordings", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const downloader = database.discover({ ...input(directory, "raw"), sourceKind: "downloader" });
    const edited = database.discover(input(directory, "edited"));
    const artifactPath = path.join(directory, "artifact.mp4");
    const stages = {
        async remux() { return artifactPath; },
        async validateArtifact() { throw new Error("not called"); },
        async describe() { throw new Error("not called"); },
    };
    const result = await new PipelineOrchestrator(database, stages, "edited-only-worker").processOne();
    assert.equal(result?.id, edited.id);
    assert.equal(result?.state, "remuxed");
    assert.equal(database.get(downloader.id)?.state, "server_ready");
});

test("stage failures persist diagnostics without continuing downstream", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    const stages = {
        async remux() { throw new Error("remux exploded"); },
        async validateArtifact() { throw new Error("not called"); },
        async describe() { throw new Error("not called"); },
    };
    const result = await new PipelineOrchestrator(database, stages, "worker-test").processOne();
    assert.equal(result.state, "failed");
    assert.equal(result.blockReason, "remux exploded");
    assert.equal(result.leaseOwner, null);
    assert.equal(database.retryFailed(recording.id).state, "server_ready");
});

test("mixed-resolution results persist a primary artifact and automatic queued upload", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    const now = new Date("2026-08-30T10:00:00.000Z").toISOString();
    const stages = {
        async remux() {
            return {
                disposition: "artifact_set",
                reason: "mixed artifacts are automatic uploads",
                primary: {
                    part: "max1080p",
                    path: path.join(directory, "max1080p.mp4"),
                    sizeBytes: 200,
                    sha256: "a".repeat(64),
                    validatedAt: now,
                    segmentCount: 8,
                    sourceDimensions: ["1920x1080"],
                },
                queued: [{
                    part: "nonmax1080p",
                    path: path.join(directory, "nonmax-upscale1080p.mp4"),
                    sizeBytes: 100,
                    sha256: "b".repeat(64),
                    validatedAt: now,
                    segmentCount: 2,
                    sourceDimensions: ["1280x720"],
                }],
            };
        },
        async validateArtifact() { throw new Error("not called"); },
        async describe() { throw new Error("not called"); },
    };
    const result = await new PipelineOrchestrator(database, stages, "resolution-worker").processOne();
    assert.equal(result.state, "artifact_valid", result.blockReason ?? undefined);
    assert.equal(result.blockReason, null);
    assert.equal(database.getArtifactPart(recording.id), "max1080p");
    assert.deepEqual(database.listQueuedProductionArtifacts(recording.id).map((artifact) => ({
        part: artifact.part,
        segmentCount: artifact.segmentCount,
        sourceDimensions: artifact.sourceDimensions,
    })), [
        { part: "nonmax1080p", segmentCount: 2, sourceDimensions: ["1280x720"] },
    ]);
    assert.equal(database.getRemuxOutput(recording.id), null);
});

test("verification promotes the converted mixed artifact and completes only after both uploads", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    const validatedAt = "2026-08-30T10:00:00.000Z";
    database.saveProductionArtifactSet(recording.id, {
        part: "max1080p",
        path: path.join(directory, "max1080p.mp4"),
        sizeBytes: 200,
        sha256: "a".repeat(64),
        validatedAt,
        segmentCount: 8,
        sourceDimensions: ["1920x1080"],
    }, [{
        part: "nonmax1080p",
        path: path.join(directory, "nonmax-upscale1080p.mp4"),
        sizeBytes: 100,
        sha256: "b".repeat(64),
        validatedAt,
        segmentCount: 2,
        sourceDimensions: ["1280x720"],
    }], "resolution-policy-v2: automatic split");
    database.saveProvenance(recording.id, {
        observedIdentifier: "alias",
        status: "resolved",
        streamerId: "streamer-id",
        alias: "alias",
        streamerUrl: "https://example.test/streamer-id",
        aliasUrl: null,
        reason: null,
        updatedAt: validatedAt,
    });

    const prepareCurrent = (sha256, label) => {
        database.saveDescription(recording.id, {
            artifactSha256: sha256,
            promptVersion: "test-v2",
            fps: 1,
            output: { title: label, description: `${label} description` },
            evidencePath: path.join(directory, `${label}.json`),
        });
        database.saveUploadMetadata(recording.id, {
            title: label,
            description: `${label} description`,
            tags: ["tango", "live"],
        });
    };
    const uploadAndVerify = (remoteId, now) => {
        const reservation = database.reserveUpload(recording.id, 250, now);
        const attempt = database.beginUpload(recording.id, reservation, now);
        database.finishUploadAttempt(attempt, {
            status: "uncertain",
            transmittedBytes: 200,
            remoteId,
            confirmation: { confirmAfter: now },
        }, now);
        database.reconcileUncertain(attempt, remoteId, `https://example.test/${remoteId}`, now);
        return database.markRemoteVerified(recording.id, remoteId, `https://example.test/${remoteId}`, now);
    };

    prepareCurrent("a".repeat(64), "max");
    const afterFirst = uploadAndVerify("remote-max", new Date("2026-08-30T11:00:00Z"));
    assert.equal(afterFirst.state, "artifact_valid");
    assert.equal(database.getArtifactPart(recording.id), "nonmax1080p");
    assert.equal(database.getArtifact(recording.id).sha256, "b".repeat(64));
    assert.equal(database.getDescription(recording.id), null);
    assert.equal(database.getUploadMetadata(recording.id), null);
    assert.deepEqual(database.listQueuedProductionArtifacts(recording.id), []);
    assert.deepEqual(database.listVerifiedUploadParts(recording.id).map((row) => row.part), ["max1080p"]);

    prepareCurrent("b".repeat(64), "converted");
    const afterSecond = uploadAndVerify("remote-converted", new Date("2026-08-30T12:00:00Z"));
    assert.equal(afterSecond.state, "xvideos_verified");
    assert.deepEqual(database.listVerifiedUploadParts(recording.id).map((row) => row.part), [
        "max1080p",
        "nonmax1080p",
    ]);
});

test("legacy local artifacts can be durably reset for the production resolution policy", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    const artifactPath = path.join(directory, "legacy-720.mp4");
    database.saveRemuxOutput(recording.id, artifactPath);
    database.saveArtifact(recording.id, {
        path: artifactPath,
        sizeBytes: 100,
        sha256: "c".repeat(64),
        validatedAt: new Date().toISOString(),
    });
    const reset = database.resetLocalWorkForResolutionPolicy(
        recording.id,
        "resolution-policy-v2: legacy 720p artifact must be rebuilt",
    );
    assert.equal(reset.recording.state, "server_ready");
    assert.deepEqual(reset.obsoletePaths, [artifactPath]);
    assert.equal(database.getArtifact(recording.id), null);
    assert.equal(database.getRemuxOutput(recording.id), null);
    assert(database.hasResolutionPolicyAssessment(recording.id, "resolution-policy-v2"));
});

test("campaign heartbeat drives the manual-command active guard", async (t) => {
    const { database } = await databaseFixture(t);
    assert.equal(database.campaignIsActive(new Date()), false);
    database.writeWorkerHeartbeat(new Date("2026-08-17T10:00:00Z"));
    assert.equal(database.campaignIsActive(new Date("2026-08-17T10:00:30Z")), true);
    assert.equal(database.campaignIsActive(new Date("2026-08-17T10:02:00Z")), false);
});

test("releaseAllLeases clears claims held by dead processes", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    const claimed = database.claimRecording(
        recording.id,
        ["server_ready"],
        "dead-worker",
        30 * 60_000,
        new Date(),
        ["edited"],
    );
    assert.equal(claimed?.id, recording.id);
    assert.equal(database.get(recording.id).leaseOwner, "dead-worker");
    assert.equal(database.releaseAllLeases(), 1);
    assert.equal(database.get(recording.id).leaseOwner, null);
});

test("blocked recordings unblock back to their pre-block state", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    database.transition(recording.id, "server_ready", "blocked", "captcha needs a human decision");
    assert.equal(database.get(recording.id).state, "blocked");
    assert.equal(database.get(recording.id).blockReason, "captcha needs a human decision");
    assert.equal(database.retryBlocked(recording.id).state, "server_ready");
    assert.equal(database.get(recording.id).blockReason, null);
});

test("the upload coordinator parks submit success as uncertain until 24-hour video-link verification", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToMetadataReady(database, recording, directory, 500);
    const now = new Date("2026-08-12T08:00:00Z");
    const reservation = database.reserveUpload(recording.id, 550, now);
    let calls = 0;
    const coordinator = new UploadCoordinator(database, {
        async upload(request) {
            calls++;
            assert.equal(request.visibility, "private");
            return {
                kind: "uploaded",
                receipt: {
                    transmittedBytes: 525,
                    submittedVideoId: "91362268",
                    metadataSubmittedAt: now.toISOString(),
                },
            };
        },
    });
    await coordinator.uploadAdmitted(recording.id, reservation, {
        recordingId: recording.id,
        artifactPath: path.join(directory, "artifact.mp4"),
        sizeBytes: 500,
        title: "Fake upload",
        description: "No network transport exists in this test.",
        tags: ["tango", "live"],
        visibility: "private",
    }, now);
    assert.equal(calls, 1);
    // Submit success is NOT accepted immediately: it waits for the 24-hour
    // public video-link verification.
    assert.equal(database.get(recording.id)?.state, "xvideos_uncertain");
    assert.deepEqual(database.uploadUsage("2026-08"), { spent: 525, reserved: 0 });
    assert.deepEqual(database.dueUploadConfirmations(new Date("2026-08-13T07:59:59Z")), []);

    const after = new Date("2026-08-13T08:00:00Z");
    const [confirmation] = database.dueUploadConfirmations(after);
    assert.ok(confirmation);
    assert.deepEqual(database.getUncertainUploadRemote(confirmation.attemptId), {
        remoteId: "91362268",
        remoteUrl: null,
    });

    // The video link opens -> that is the success signal.
    database.reconcileUncertain(confirmation.attemptId, "91362268",
        "https://www.xvideos.com/video.91362268/", after);
    database.markRemoteVerified(recording.id, "91362268",
        "https://www.xvideos.com/video.91362268/", after);
    assert.equal(database.get(recording.id)?.state, "xvideos_verified");
});

test("transport errors meter bytes and uncertain acceptance cannot retry", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToMetadataReady(database, recording, directory, 500);
    const now = new Date("2026-08-12T08:00:00Z");
    const reservation = database.reserveUpload(recording.id, 550, now);
    const coordinator = new UploadCoordinator(database, {
        async upload() {
            throw new UploadTransportError("response disappeared", 525, true);
        },
    });
    await assert.rejects(() => coordinator.uploadAdmitted(recording.id, reservation, {
        recordingId: recording.id,
        artifactPath: path.join(directory, "artifact.mp4"),
        sizeBytes: 500,
        title: "Fake upload",
        description: "No network transport exists in this test.",
        tags: ["tango", "live"],
        visibility: "private",
    }, now), /response disappeared/);
    assert.equal(database.get(recording.id)?.state, "xvideos_uncertain");
    assert.deepEqual(database.uploadUsage("2026-08"), { spent: 525, reserved: 0 });
});

test("restart recovery retries only before transfer starts, never after possible acceptance", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToMetadataReady(database, recording, directory, 500);
    const firstNow = new Date("2026-08-12T08:00:00Z");
    const firstReservation = database.reserveUpload(recording.id, 550, firstNow);
    const firstAttempt = database.beginUpload(recording.id, firstReservation, firstNow);
    // No file-upload progress was recorded: this is the only retryable case.
    assert.deepEqual(database.recoverInterruptedUploads(new Date("2026-08-12T08:01:00Z")), [{
        recordingId: recording.id,
        disposition: "retryable",
    }]);
    assert.equal(database.get(recording.id)?.state, "metadata_ready");
    assert.deepEqual(database.uploadUsage("2026-08"), { spent: 0, reserved: 0 });

    const secondNow = new Date("2026-08-12T09:00:00Z");
    const secondReservation = database.reserveUpload(recording.id, 550, secondNow);
    const secondAttempt = database.beginUpload(recording.id, secondReservation, secondNow);
    database.updateUploadProgress(secondAttempt, "file_uploaded", 500, secondNow);
    database.updateUploadProgress(secondAttempt, "metadata_submitting", 500, secondNow);
    assert.deepEqual(database.recoverInterruptedUploads(new Date("2026-08-12T09:01:00Z")), [{
        recordingId: recording.id,
        disposition: "confirmation_required",
    }]);
    assert.equal(database.get(recording.id)?.state, "xvideos_uncertain");
    assert.equal(database.dueUploadConfirmations(new Date("2026-08-13T09:00:59Z")).length, 0);
    assert.equal(database.dueUploadConfirmations(new Date("2026-08-13T09:01:00Z")).length, 1);
    assert.deepEqual(database.uploadUsage("2026-08"), { spent: 500, reserved: 0 });
});

for (const bytes of [0, 500]) {
test(`interrupted file-uploading phase cannot retry blindly (${bytes} bytes recorded)`, async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToMetadataReady(database, recording, directory, 500);
    const now = new Date("2026-08-12T11:00:00Z");
    const reservation = database.reserveUpload(recording.id, 550, now);
    const attempt = database.beginUpload(recording.id, reservation, now);
    database.updateUploadProgress(attempt, "file_uploading", bytes, now);
    assert.deepEqual(database.recoverInterruptedUploads(new Date("2026-08-12T11:01:00Z")), [{
        recordingId: recording.id, disposition: "confirmation_required",
    }]);
    assert.equal(database.get(recording.id).state, "xvideos_uncertain");
    assert.throws(() => database.reserveUpload(recording.id, 550, now));
});
}

test("interrupted upload after the file completed requires confirmation before retry", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToMetadataReady(database, recording, directory, 500);
    const now = new Date("2026-08-12T11:00:00Z");
    const reservation = database.reserveUpload(recording.id, 550, now);
    const attempt = database.beginUpload(recording.id, reservation, now);
    database.updateUploadProgress(attempt, "file_uploading", 500, now);
    database.updateUploadProgress(attempt, "file_uploaded", 500, now);
    assert.deepEqual(database.recoverInterruptedUploads(new Date("2026-08-12T11:01:00Z")), [{
        recordingId: recording.id,
        disposition: "confirmation_required",
    }]);
    assert.equal(database.get(recording.id)?.state, "xvideos_uncertain");
    assert.equal(database.dueUploadConfirmations(new Date("2026-08-13T11:01:00Z")).length, 1);
});
