import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { guardUploadIdentity } from "../dist/commands/uploadIdentityGuard.js";
import { composeUploadMetadata } from "../dist/metadata/composeUploadMetadata.js";
import { TargetCatalogResolver } from "../dist/provenance/targetResolver.js";
import { filterOldHostEntries } from "../dist/upload/oldhostEntries.js";
import { UploadCoordinator } from "../dist/upload/uploadCoordinator.js";

async function rootFixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-upload-flow-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // The resolver delegates to the per-provider server capability; the test
    // injects a stub standing in for GET /api/{provider}/resolve.
    const resolver = TargetCatalogResolver.load({
        resolveIdentifier: async (provider, identifier) => {
            if (provider === "tslive" && identifier === "old_alias") {
                return { id: "account-id", label: "current_alias" };
            }
            if (provider === "ladder" && identifier === "68190398") {
                return { id: "68190398", label: "68190398" };
            }
            if (provider === "fmp4" && identifier === "channel-561") {
                return { id: "226494362", label: "channel-561" };
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
    const tslive = await resolver.resolve(input(root, "tslive", "2026-08-13 101112 old_alias"));
    assert.deepEqual({
        status: tslive.status,
        streamerId: tslive.streamerId,
        alias: tslive.alias,
        streamerUrl: tslive.streamerUrl,
        aliasUrl: tslive.aliasUrl,
    }, {
        status: "resolved",
        streamerId: "account-id",
        alias: "current_alias",
        streamerUrl: "https://ts-live.example/account-id",
        aliasUrl: "https://ts-live.example/current_alias",
    });
    assert.equal((await resolver.resolve(input(root, "ladder", "2026-08-13 101112 68190398"))).status, "resolved");
    assert.equal((await resolver.resolve(input(root, "fmp4", "2026-08-13 101112 channel-561"))).streamerId, "226494362");
    assert.equal(
        (await resolver.resolve(input(root, "fmp4", "2026-08-13 101112 previous_fmp4_alias"))).status,
        "review_required",
    );
});

test("metadata reserves provenance room and uses fixed provider/live tags", async (t) => {
    const { root } = await rootFixture(t);
    const source = input(root, "fmp4", "2026-08-13 101112 channel-561");
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
            title: "Woman performs in a brightly lit bedroom",
            description: "A woman stands beside a bed and speaks to the camera. She changes position and adjusts her clothing.",
            tags: ["Live", "Solo Female", "bedroom", "solo-female"],
        },
        evidencePath: path.join(root, "evidence.json"),
        createdAt: "2026-08-13T08:00:00Z",
    }, {
        recordingId: recording.id,
        observedIdentifier: "channel-561",
        status: "resolved",
        streamerId: "226494362",
        alias: "channel-561",
        streamerUrl: "https://fmp4-live.example/226494362",
        aliasUrl: "https://fmp4-live.example/channel-561",
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    assert.deepEqual(metadata.tags, ["fmp4live", "live"]);
    assert(metadata.title.includes("[2026-08-13 101112 channel-561]"));
    assert(metadata.description.includes("Recorded: 2026-08-13 10:11:12"));
    assert(metadata.description.includes("Source: https://fmp4-live.example/226494362"));
    assert(metadata.description.includes("Alias: https://fmp4-live.example/channel-561"));
    assert(metadata.description.length <= 1_000);
});

test("uploads-list matching filters entries by title search term", () => {
    const entries = filterOldHostEntries([{
        containerId: "listing-video-85165541",
        remoteUrl: "https://old-host.example/video.example/title",
        title: "Specific title [ladder-deadbeef1234]",
    }, {
        containerId: "listing-video-99999999",
        remoteUrl: "https://old-host.example/video.example/other",
        title: "Unrelated title",
    }], "[ladder-deadbeef1234]");
    assert.deepEqual(entries, [{
        remoteId: "85165541",
        remoteUrl: "https://old-host.example/video.example/title",
        title: "Specific title [ladder-deadbeef1234]",
    }]);
});

test("one manual alias override resolves every matching recording and survives refreshes", async (t) => {
    const { root } = await rootFixture(t);
    const database = new PipelineDatabase(path.join(root, "manual.sqlite"));
    t.after(() => database.close());
    const first = database.discover(input(root, "fmp4", "2026-08-13 101112 old_name"));
    const second = database.discover(input(root, "fmp4", "2026-08-14 121314 old_name"));
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
        streamerUrl: "https://fmp4-live.example/123456",
        aliasUrl: "https://fmp4-live.example/current_name",
    });
    assert.equal(database.getProvenance(first.id)?.status, "manual");
    assert.equal(database.getProvenance(second.id)?.streamerId, "123456");
    const override = database.getProvenanceOverride("fmp4", "old_name");
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

test("uncertain metadata submission cannot retry before 24 hours and becomes retryable only after absence", async (t) => {
    const { root } = await rootFixture(t);
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const recording = database.discover(input(root, "ladder", "2026-08-13 101112 68190398"));
    database.transition(recording.id, "server_ready", "remuxed");
    database.saveArtifact(recording.id, {
        path: path.join(root, "artifact.mp4"),
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
        observedIdentifier: "68190398",
        status: "resolved",
        streamerId: "68190398",
        alias: "68190398",
        streamerUrl: "https://ladder-live.example/68190398/",
        aliasUrl: null,
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    database.saveUploadMetadata(recording.id, {
        title: "Specific title [2026-08-13 101112 68190398]",
        description: "Specific concrete description.\n\nSource: https://ladder-live.example/68190398/",
        tags: ["ladder", "live"],
    });
    const submittedAt = new Date("2026-08-13T08:00:00Z");
    const reservation = database.reserveUpload(recording.id, 100, submittedAt);
    const attempt = database.beginUpload(recording.id, reservation, submittedAt);
    database.finishUploadAttempt(attempt, {
        status: "uncertain",
        transmittedBytes: 100,
        error: "entry not visible immediately",
        confirmation: { confirmAfter: new Date("2026-08-14T08:00:00Z") },
    }, submittedAt);
    assert.deepEqual(database.dueUploadConfirmations(new Date("2026-08-14T07:59:59Z")), []);
    assert.throws(() => database.markConfirmationAbsent(attempt, new Date("2026-08-14T07:59:59Z")), /not due/);
    assert.equal(database.dueUploadConfirmations(new Date("2026-08-14T08:00:00Z")).length, 1);
    assert.equal(database.markConfirmationAbsent(attempt, new Date("2026-08-14T08:00:00Z")).state, "metadata_ready");
});

test("failure after the upload started is acceptance-unknown instead of an immediate blind retry", async (t) => {
    const { root } = await rootFixture(t);
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const recording = database.discover(input(root, "ladder", "2026-08-13 101112 68190398"));
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
        observedIdentifier: "68190398",
        status: "resolved",
        streamerId: "68190398",
        alias: "68190398",
        streamerUrl: "https://ladder-live.example/68190398/",
        aliasUrl: null,
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    database.saveUploadMetadata(recording.id, {
        title: "Specific title [2026-08-13 101112 68190398]",
        description: "Specific concrete description.\n\nSource: https://ladder-live.example/68190398/",
        tags: ["ladder", "live"],
    });
    const now = new Date("2026-08-13T08:00:00Z");
    const reservationId = database.reserveUpload(recording.id, 100, now);
    const failingUploader = {
        async upload(request) {
            await request.onProgress?.("file_uploading", request.sizeBytes);
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
                title: "Specific title [2026-08-13 101112 68190398]",
                description: "Specific concrete description.",
                tags: ["ladder", "live"],
                visibility: "private",
            },
            now,
        ),
        /locator.fill timed out mid-flight/,
    );
    // The run must NOT drop back to metadata_ready for an immediate retry that
    // would re-upload the file: it stays uncertain until a reconciliation pass
    // confirms whether the upload landed.
    assert.equal(database.get(recording.id)?.state, "oldhost_uncertain");
    assert.equal(database.dueUploadConfirmations(new Date("2026-08-14T08:00:00Z")).length, 1);
});

test("the upload identity guard refuses unverified and cleans verified recordings", async (t) => {
    const { root } = await rootFixture(t);
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const recording = database.discover(input(root, "ladder", "2026-08-13 101112 68190398"));
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
        observedIdentifier: "68190398",
        status: "resolved",
        streamerId: "68190398",
        alias: "68190398",
        streamerUrl: "https://ladder-live.example/68190398/",
        aliasUrl: null,
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    database.saveUploadMetadata(recording.id, {
        title: "Specific title [2026-08-13 101112 68190398]",
        description: "Specific concrete description.\n\nSource: https://ladder-live.example/68190398/",
        tags: ["ladder", "live"],
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
    // accelerated so the next reconcile verifies it.
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
    database.reconcileUncertain(attemptId, "91362268", "https://old-host.example/video.abc123/title", now);
    database.markRemoteVerified(recording.id, "91362268", "https://old-host.example/video.abc123/title", now);
    assert.equal(confirmation.attemptId, attemptId);
    const verified = await guardUploadIdentity(database, database.get(recording.id), { cleanupEnabled: true });
    assert.deepEqual(verified, {
        kind: "verified_cleaned",
        remoteId: "91362268",
        remoteUrl: "https://old-host.example/video.abc123/title",
    });
    assert.equal(database.get(recording.id)?.state, "cleanup_eligible");
    await assert.rejects(access(artifactPath), /ENOENT/);
});
