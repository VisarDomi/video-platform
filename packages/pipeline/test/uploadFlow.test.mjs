import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { guardUploadIdentity } from "../dist/commands/uploadIdentityGuard.js";
import { composeUploadMetadata, hasDiagnosticUploadIdentity } from "../dist/metadata/composeUploadMetadata.js";
import { TargetCatalogResolver } from "../dist/provenance/targetResolver.js";
import { UploadCoordinator } from "../dist/upload/uploadCoordinator.js";
import { PipelineOrchestrator, StageDeferredError } from "../dist/scheduler/orchestrator.js";

async function rootFixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-upload-flow-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // The resolver delegates to the per-provider server capability; the test
    // injects a stub standing in for GET /api/{provider}/resolve, which also answers the
    // site's pages (each catalog's sourceLinks, pinned in private/test).
    const resolver = TargetCatalogResolver.load({
        resolveIdentifier: async (provider, identifier) => {
            if (provider === "live-a" && identifier === "old_alias") {
                return { id: "account-id", label: "current_alias", channelUrl: "https://live-a.example/account-id", aliasUrl: "https://live-a.example/current_alias" };
            }
            if (provider === "live-b" && identifier === "2002") {
                return { id: "2002", label: "2002", channelUrl: "https://live-b.example/2002/", aliasUrl: null };
            }
            if (provider === "live-c" && identifier === "centre_court") {
                return { id: "1001", label: "centre_court", channelUrl: "https://live-c.example/1001", aliasUrl: "https://live-c.example/centre_court" };
            }
            return null;
        },
    });
    return { root, resolver };
}

function input(root, provider, filename) {
    const sourcePath = path.join(root, filename);
    return {
        provider,
        sourceKind: "edited",
        sourcePath,
        playlistPath: path.join(sourcePath, "playlist.m3u8"),
        sourceFingerprint: `fingerprint-${provider}-${filename}`,
        durationSeconds: 600,
    };
}

test("provenance resolution delegates to the per-provider server resolver", async (t) => {
    const { root, resolver } = await rootFixture(t);
    const liveA = await resolver.resolve(input(root, "live-a", "2026-08-13 101112 old_alias"));
    assert.deepEqual({
        status: liveA.status,
        streamerId: liveA.streamerId,
        alias: liveA.alias,
        streamerUrl: liveA.streamerUrl,
        aliasUrl: liveA.aliasUrl,
    }, {
        status: "resolved",
        streamerId: "account-id",
        alias: "current_alias",
        streamerUrl: "https://live-a.example/account-id",
        aliasUrl: "https://live-a.example/current_alias",
    });
    assert.equal((await resolver.resolve(input(root, "live-b", "2026-08-13 101112 2002"))).status, "resolved");
    assert.equal((await resolver.resolve(input(root, "live-c", "2026-08-13 101112 centre_court"))).streamerId, "1001");
    assert.equal(
        (await resolver.resolve(input(root, "live-c", "2026-08-13 101112 previous_alias"))).status,
        "review_required",
    );
});

test("metadata reserves provenance room and uses the profile's tags", async (t) => {
    const { root } = await rootFixture(t);
    const source = input(root, "live-c", "2026-08-13 101112 centre_court");
    const recording = {
        ...source,
        id: "a".repeat(64),
        state: "described",
        blockReason: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        attemptCount: 0,
        createdAt: "2026-08-13T08:00:00Z",
        updatedAt: "2026-08-13T08:00:00Z",
    };
    const metadata = composeUploadMetadata(recording, {
        recordingId: recording.id,
        artifactSha256: "b".repeat(64),
        promptVersion: "test",
        fps: 1,
        output: {
            title: "Two players trade long rallies on a grass court",
            description: "Two players rally from the baseline on a grass court. The player in white wins the point at the net.",
            tags: ["Tennis", "Grass Court", "rally", "grass-court"],
        },
        evidencePath: path.join(root, "evidence.json"),
        createdAt: "2026-08-13T08:00:00Z",
    }, {
        recordingId: recording.id,
        observedIdentifier: "centre_court",
        status: "resolved",
        streamerId: "1001",
        alias: "centre_court",
        streamerUrl: "https://live-c.example/1001",
        aliasUrl: "https://live-c.example/centre_court",
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    assert.deepEqual(metadata.tags, ["live-c", "tennis"]);
    assert.equal(metadata.title, "Two players trade long rallies on a grass court [2026-08-13 101112 centre_court]");
    assert(metadata.description.includes("Recorded: 2026-08-13 10:11:12"));
    assert(metadata.description.includes("Source: https://live-c.example/1001"));
    assert(metadata.description.includes("Alias: https://live-c.example/centre_court"));
    assert(metadata.description.length <= 1_000);
});

test("production restores v1 model title plus basename; only explicit trials add version/part", () => {
    const recording = { sourcePath: "/source/2026-09-09 120000 alias" };
    const description = { output: { title: "A natural descriptive title", description: "Visible actions." } };
    const provenance = { status: "resolved", streamerUrl: "https://example.test/source" };
    const clean = composeUploadMetadata(recording, description, provenance);
    const diagnostic = composeUploadMetadata(recording, description, provenance, "full", { diagnosticTitle: true });
    assert.equal(clean.title, `${description.output.title} [2026-09-09 120000 alias]`);
    assert(!clean.title.includes("production-v"));
    const identity = "2026-09-09 120000 alias | production-v6 | full";
    assert.equal(diagnostic.title, `${description.output.title} [${identity}]`);
    assert.equal(hasDiagnosticUploadIdentity(clean.title, identity), false);
    assert.equal(hasDiagnosticUploadIdentity(diagnostic.title, identity), true);
    assert.equal(hasDiagnosticUploadIdentity(diagnostic.title, identity.replace("v6", "v2")), false);
    assert.equal(clean.description, diagnostic.description);
    for (const diagnosticTitle of [false, true]) {
        const long = composeUploadMetadata(recording, { output: { ...description.output, title: "Natural title ".repeat(100) } },
            provenance, "full", { diagnosticTitle });
        assert(long.title.length <= 255);
        if (!diagnosticTitle) assert(long.title.endsWith(" [2026-09-09 120000 alias]"));
        assert.equal(hasDiagnosticUploadIdentity(long.title, identity), diagnosticTitle);
    }
});

test("orchestrator enables diagnostic titles only for a prepared comparison trial", async (t) => {
    const { root } = await rootFixture(t);
    for (const comparison of [false, true]) {
        const db = new PipelineDatabase(path.join(root, `titles-${comparison}.sqlite`));
        try {
            if (comparison) db.prepareComparisonTrial();
            const recording = db.discover(input(root, "live-b", "2026-09-09 120000 12345"));
            db.saveProvenance(recording.id, { observedIdentifier: "12345", status: "resolved", streamerId: "12345",
                alias: "12345", streamerUrl: "https://live-b.example/12345/", aliasUrl: null, reason: null,
                updatedAt: new Date().toISOString() });
            const artifactPath = path.join(root, "fixture.mp4");
            const orchestrator = new PipelineOrchestrator(db, {
                remux: async () => artifactPath,
                validateArtifact: async () => ({ path: artifactPath, sizeBytes: 100, sha256: "a".repeat(64),
                    validatedAt: new Date().toISOString() }),
                describe: async () => ({ artifactSha256: "a".repeat(64), promptVersion: "test", fps: 1,
                    output: { title: "Natural public title", description: "Factual description." }, evidencePath: "fixture.json" }),
            }, "test-worker");
            for (let i = 0; i < 4; i++) await orchestrator.processRecording(recording.id);
            assert.equal(db.get(recording.id).state, "metadata_ready");
            assert.equal(db.getUploadMetadata(recording.id).title, comparison
                ? "Natural public title [2026-09-09 120000 12345 | production-v6 | full]"
                : "Natural public title [2026-09-09 120000 12345]");
        } finally { db.close(); }
    }
});

test("a deferred stage leaves the recording in its state, unleased, for a later step", async (t) => {
    const { root } = await rootFixture(t);
    const db = new PipelineDatabase(path.join(root, "deferred.sqlite"));
    t.after(() => db.close());
    const recording = db.discover(input(root, "live-b", "2026-09-09 120000 12345"));
    const artifactPath = path.join(root, "fixture.mp4");
    let deferred = true;
    const orchestrator = new PipelineOrchestrator(db, {
        remux: async () => artifactPath,
        validateArtifact: async () => ({ path: artifactPath, sizeBytes: 100, sha256: "a".repeat(64), validatedAt: new Date().toISOString() }),
        describe: async () => {
            if (deferred) throw new StageDeferredError("waiting for memory");
            return { artifactSha256: "a".repeat(64), promptVersion: "test", fps: 1,
                output: { title: "Natural public title", description: "Factual description." }, evidencePath: "fixture.json" };
        },
    }, "test-worker");
    for (let i = 0; i < 2; i++) await orchestrator.processRecording(recording.id);
    assert.equal(db.get(recording.id).state, "artifact_valid");
    await assert.rejects(orchestrator.processRecording(recording.id), StageDeferredError);
    assert.equal(db.get(recording.id).state, "artifact_valid");
    assert.equal(db.get(recording.id).leaseOwner ?? null, null);
    deferred = false;
    await orchestrator.processRecording(recording.id);
    assert.equal(db.get(recording.id).state, "described");
});

test("a stage killed by a service stop leaves the recording in its state", async (t) => {
    const { markStopping } = await import("../dist/shutdown.js");
    const { root } = await rootFixture(t);
    const db = new PipelineDatabase(path.join(root, "stopping.sqlite"));
    t.after(() => db.close());
    const recording = db.discover(input(root, "live-b", "2026-09-09 120000 12345"));
    const orchestrator = new PipelineOrchestrator(db, {
        remux: async () => { markStopping(); throw new Error("ffmpeg exited (SIGTERM)"); },
        validateArtifact: async () => { throw new Error("not reached"); },
        describe: async () => { throw new Error("not reached"); },
    }, "test-worker");
    await assert.rejects(orchestrator.processRecording(recording.id), StageDeferredError);
    assert.equal(db.get(recording.id).state, "server_ready");
});

test("one manual alias override resolves every matching recording and survives refreshes", async (t) => {
    const { root } = await rootFixture(t);
    const database = new PipelineDatabase(path.join(root, "manual.sqlite"));
    t.after(() => database.close());
    const first = database.discover(input(root, "live-c", "2026-08-13 101112 old_name"));
    const second = database.discover(input(root, "live-c", "2026-08-14 121314 old_name"));
    for (const recording of [first, second]) {
        database.saveProvenance(recording.id, {
            observedIdentifier: "old_name",
            status: "review_required",
            streamerId: null,
            alias: null,
            streamerUrl: null,
            aliasUrl: null,
            reason: "identifier_not_resolved_by_current_target_catalog",
            updatedAt: "2026-08-13T08:00:00Z",
        });
    }
    database.saveManualProvenance(first.id, {
        streamerId: "123456",
        alias: "current_name",
        streamerUrl: "https://live-c.example/123456",
        aliasUrl: "https://live-c.example/current_name",
    });
    assert.equal(database.getProvenance(first.id)?.status, "manual");
    assert.equal(database.getProvenance(second.id)?.streamerId, "123456");
    const override = database.getProvenanceOverride("live-c", "old_name");
    assert.equal(override?.alias, "current_name");
    database.saveProvenance(first.id, {
        observedIdentifier: "old_name",
        status: "review_required",
        streamerId: null,
        alias: null,
        streamerUrl: null,
        aliasUrl: null,
        reason: "refresh failed",
        updatedAt: "2026-08-15T08:00:00Z",
    });
    assert.equal(database.getProvenance(first.id)?.status, "manual");
});

test("failure after the upload started is acceptance-unknown instead of an immediate blind retry", async (t) => {
    const { root } = await rootFixture(t);
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const recording = database.discover(input(root, "live-b", "2026-08-13 101112 2002"));
    database.transition(recording.id, "server_ready", "remuxed");
    const artifactPath = path.join(root, "artifact.mp4");
    database.saveArtifact(recording.id, {
        path: artifactPath,
        sizeBytes: 100,
        sha256: "c".repeat(64),
        validatedAt: "2026-08-13T08:00:00Z",
    });
    database.saveDescription(recording.id, {
        artifactSha256: "c".repeat(64),
        promptVersion: "test",
        fps: 1,
        output: { title: "Specific title", description: "Specific concrete description.", tags: ["room"] },
        evidencePath: path.join(root, "evidence.json"),
    });
    database.saveProvenance(recording.id, {
        observedIdentifier: "2002",
        status: "resolved",
        streamerId: "2002",
        alias: "2002",
        streamerUrl: "https://live-b.example/2002/",
        aliasUrl: null,
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    database.saveUploadMetadata(recording.id, {
        title: "Specific title [2026-08-13 101112 2002]",
        description: "Specific concrete description.\n\nSource: https://live-b.example/2002/",
        tags: ["live-b", "tennis"],
    });
    const now = new Date("2026-08-13T08:00:00Z");
    const reservationId = database.reserveUpload(recording.id, 100, now);
    const failingUploader = {
        async upload(request) {
            await request.onProgress?.("metadata_submitting", request.sizeBytes);
            throw new Error("locator.fill timed out mid-flight");
        },
    };
    await assert.rejects(
        () => new UploadCoordinator(database, failingUploader).uploadAdmitted(
            recording.id,
            reservationId,
            {
                recordingId: recording.id,
                artifactPath,
                sizeBytes: 100,
                title: "Specific title [2026-08-13 101112 2002]",
                description: "Specific concrete description.",
                tags: ["live-b", "tennis"],
                visibility: "private",
            },
            now,
        ),
        /locator.fill timed out mid-flight/,
    );
    // The run must NOT drop back to metadata_ready for an immediate retry that
    // would re-upload the file: it stays uncertain until a reconciliation pass
    // confirms whether the upload landed.
    assert.equal(database.get(recording.id)?.state, "upload_uncertain");
    assert.equal(database.dueUploadConfirmations(new Date("2026-08-14T08:00:00Z")).length, 1);
});

test("the upload identity guard refuses unverified and cleans verified recordings", async (t) => {
    const { root } = await rootFixture(t);
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const recording = database.discover(input(root, "live-b", "2026-08-13 101112 2002"));
    database.transition(recording.id, "server_ready", "remuxed");
    const artifactPath = path.join(root, "artifact.mp4");
    await writeFile(artifactPath, "artifact-bytes");
    database.saveArtifact(recording.id, {
        path: artifactPath,
        sizeBytes: 100,
        sha256: "c".repeat(64),
        validatedAt: "2026-08-13T08:00:00Z",
    });
    database.saveDescription(recording.id, {
        artifactSha256: "c".repeat(64),
        promptVersion: "test",
        fps: 1,
        output: { title: "Specific title", description: "Specific concrete description.", tags: ["room"] },
        evidencePath: path.join(root, "evidence.json"),
    });
    database.saveProvenance(recording.id, {
        observedIdentifier: "2002",
        status: "resolved",
        streamerId: "2002",
        alias: "2002",
        streamerUrl: "https://live-b.example/2002/",
        aliasUrl: null,
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    database.saveUploadMetadata(recording.id, {
        title: "Specific title [2026-08-13 101112 2002]",
        description: "Specific concrete description.\n\nSource: https://live-b.example/2002/",
        tags: ["live-b", "tennis"],
    });
    const now = new Date("2026-08-13T08:00:00Z");
    const reservationId = database.reserveUpload(recording.id, 100, now);
    const attemptId = database.beginUpload(recording.id, reservationId, now);
    database.finishUploadAttempt(attemptId, {
        status: "uncertain",
        transmittedBytes: 100,
        remoteId: "91362268",
        error: "metadata submitted",
        confirmation: { confirmAfter: new Date("2026-08-14T08:00:00Z") },
    }, now);

    // Unverified identity: every job refuses, and the pending confirmation is
    // retained without changing its deadline.
    const unverified = await guardUploadIdentity(database, database.get(recording.id), { cleanupEnabled: true });
    assert.deepEqual(unverified, {
        kind: "unverified_refused",
        remoteId: "91362268",
        verificationScheduled: true,
    });
    assert.equal(database.dueUploadConfirmations(new Date()).length, 1);

    // Once verified, the guard cleans the staging artifact and parks the
    // recording at cleanup_eligible.
    const [confirmation] = database.dueUploadConfirmations(new Date());
    database.reconcileUncertain(attemptId, "91362268", "https://video-host.example/video.abc123/title", now);
    database.markRemoteVerified(recording.id, "91362268", "https://video-host.example/video.abc123/title", now);
    assert.equal(confirmation.attemptId, attemptId);
    const verified = await guardUploadIdentity(database, database.get(recording.id), { cleanupEnabled: true });
    assert.deepEqual(verified, {
        kind: "verified_retained",
        remoteId: "91362268",
        remoteUrl: "https://video-host.example/video.abc123/title",
    });
    assert.equal(database.get(recording.id)?.state, "cleanup_eligible");
    await access(artifactPath); // No matching acceptance snapshot: retain unproven bytes.
});
