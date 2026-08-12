import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
        sourceKind: "downloader",
        sourcePath,
        playlistPath: path.join(sourcePath, "playlist.m3u8"),
        sourceFingerprint: `fingerprint-${suffix}`,
        durationSeconds: 600,
    };
}

function advanceToRemuxed(database, id) {
    database.transition(id, "server_ready", "remuxed");
}

function advanceToDescribed(database, recording, directory, sizeBytes = 1_000) {
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
        output: { title: "Test" },
        evidencePath: path.join(directory, "evidence.json"),
    });
    return database.get(recording.id);
}

test("schema initialization is idempotent and discovery deduplicates across restarts", async (t) => {
    const { database, databasePath, directory } = await databaseFixture(t, false);
    const first = database.discover(input(directory));
    const second = database.discover(input(directory));
    assert.equal(first.id, second.id);
    assert.equal(database.list().length, 1);
    assert.equal(database.integrityCheck(), "ok");

    database.close();
    const reopened = new PipelineDatabase(databasePath);
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.integrityCheck(), "ok");
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
    assert.throws(() => database.transition(recording.id, "server_ready", "artifact_valid"), /Invalid pipeline transition/);
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

test("monthly quota reserves atomically, counts retries, and rolls over by timezone", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const first = database.discover(input(directory, "one"));
    const second = database.discover(input(directory, "two"));
    advanceToDescribed(database, first, directory, 600);
    advanceToDescribed(database, second, directory, 500);
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
    advanceToDescribed(database, recording, directory, 1_000);
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
    advanceToDescribed(database, recording, directory, 500);
    const now = new Date("2026-08-12T08:00:00Z");
    const reservation = database.reserveUpload(recording.id, 500, now);
    const attempt = database.beginUpload(recording.id, reservation, now);
    assert.equal(database.finishUploadAttempt(attempt, {
        status: "uncertain",
        transmittedBytes: 500,
        error: "response lost after request body was sent",
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
    advanceToDescribed(database, recording, directory, 400);
    const before = database.get(recording.id);
    const first = createDryRunUploadPlan(database, new Date("2026-08-12T08:00:00Z"), "Europe/Tirane", 1_000);
    const second = createDryRunUploadPlan(database, new Date("2026-08-12T08:00:00Z"), "Europe/Tirane", 1_000);
    assert.deepEqual(first, second);
    assert.equal(first[0].disposition, "would_upload");
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

test("the upload coordinator records fake transport success without a real network", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToDescribed(database, recording, directory, 500);
    const now = new Date("2026-08-12T08:00:00Z");
    const reservation = database.reserveUpload(recording.id, 550, now);
    let calls = 0;
    const coordinator = new UploadCoordinator(database, {
        async upload(request) {
            calls++;
            assert.equal(request.visibility, "private");
            return {
                remoteId: "fake-remote",
                remoteUrl: "https://example.invalid/fake-remote",
                transmittedBytes: 525,
            };
        },
    });
    await coordinator.uploadAdmitted(recording.id, reservation, {
        recordingId: recording.id,
        artifactPath: path.join(directory, "artifact.mp4"),
        sizeBytes: 500,
        title: "Fake upload",
        description: "No network transport exists in this test.",
        visibility: "private",
    }, now);
    assert.equal(calls, 1);
    assert.equal(database.get(recording.id)?.state, "xvideos_uploaded");
    assert.deepEqual(database.uploadUsage("2026-08"), { spent: 525, reserved: 0 });
});

test("transport errors meter bytes and uncertain acceptance cannot retry", async (t) => {
    const { database, directory } = await databaseFixture(t);
    const recording = database.discover(input(directory));
    advanceToDescribed(database, recording, directory, 500);
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
        visibility: "private",
    }, now), /response disappeared/);
    assert.equal(database.get(recording.id)?.state, "xvideos_uncertain");
    assert.deepEqual(database.uploadUsage("2026-08"), { spent: 525, reserved: 0 });
});
