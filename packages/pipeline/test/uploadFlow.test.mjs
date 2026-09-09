import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { guardUploadIdentity } from "../dist/commands/uploadIdentityGuard.js";
import { composeUploadMetadata, hasDiagnosticUploadIdentity } from "../dist/metadata/composeUploadMetadata.js";
import { ChromiumXvideosUploader, submittedUploadEditId } from "../dist/upload/chromiumXvideosUploader.js";
import { TargetCatalogResolver } from "../dist/provenance/targetResolver.js";
import { filterXvideosEntries } from "../dist/upload/xvideosEntries.js";
import { UploadCoordinator } from "../dist/upload/uploadCoordinator.js";
import { PipelineOrchestrator } from "../dist/scheduler/orchestrator.js";

async function rootFixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-upload-flow-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // The resolver delegates to the per-provider server capability; the test
    // injects a stub standing in for GET /api/{provider}/resolve.
    const resolver = TargetCatalogResolver.load({
        resolveIdentifier: async (provider, identifier) => {
            if (provider === "tango" && identifier === "old_alias") {
                return { id: "account-id", label: "current_alias" };
            }
            if (provider === "fc2" && identifier === "68190398") {
                return { id: "68190398", label: "68190398" };
            }
            if (provider === "sc" && identifier === "Minami_jjjj") {
                return { id: "226494362", label: "Minami_jjjj" };
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
    const tango = await resolver.resolve(input(root, "tango", "2026-08-13 101112 old_alias"));
    assert.deepEqual({
        status: tango.status,
        streamerId: tango.streamerId,
        alias: tango.alias,
        streamerUrl: tango.streamerUrl,
        aliasUrl: tango.aliasUrl,
    }, {
        status: "resolved",
        streamerId: "account-id",
        alias: "current_alias",
        streamerUrl: "https://tango.me/account-id",
        aliasUrl: "https://tango.me/current_alias",
    });
    assert.equal((await resolver.resolve(input(root, "fc2", "2026-08-13 101112 68190398"))).status, "resolved");
    assert.equal((await resolver.resolve(input(root, "sc", "2026-08-13 101112 Minami_jjjj"))).streamerId, "226494362");
    assert.equal(
        (await resolver.resolve(input(root, "sc", "2026-08-13 101112 previous_sc_alias"))).status,
        "review_required",
    );
});

test("metadata reserves provenance room and uses fixed provider/live tags", async (t) => {
    const { root } = await rootFixture(t);
    const source = input(root, "sc", "2026-08-13 101112 Minami_jjjj");
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
        observedIdentifier: "Minami_jjjj",
        status: "resolved",
        streamerId: "226494362",
        alias: "Minami_jjjj",
        streamerUrl: "https://stripchat.com/226494362",
        aliasUrl: "https://stripchat.com/Minami_jjjj",
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    assert.deepEqual(metadata.tags, ["stripchat", "live"]);
    assert.equal(metadata.title, "Woman performs in a brightly lit bedroom");
    assert(metadata.description.includes("Recorded: 2026-08-13 10:11:12"));
    assert(metadata.description.includes("Source: https://stripchat.com/226494362"));
    assert(metadata.description.includes("Alias: https://stripchat.com/Minami_jjjj"));
    assert(metadata.description.length <= 1_000);
});

test("diagnostic title suffix is explicit, default campaign titles stay clean and bounded", () => {
    const recording = { sourcePath: "/source/2026-09-09 120000 alias" };
    const description = { output: { title: "A natural descriptive title", description: "Visible actions." } };
    const provenance = { status: "resolved", streamerUrl: "https://example.test/source" };
    const clean = composeUploadMetadata(recording, description, provenance);
    const diagnostic = composeUploadMetadata(recording, description, provenance, "full", { diagnosticTitle: true });
    assert.equal(clean.title, description.output.title);
    const identity = "2026-09-09 120000 alias | production-v3 | full";
    assert.equal(diagnostic.title, `${clean.title} [${identity}]`);
    assert.equal(hasDiagnosticUploadIdentity(clean.title, identity), false);
    assert.equal(hasDiagnosticUploadIdentity(diagnostic.title, identity), true);
    assert.equal(hasDiagnosticUploadIdentity(diagnostic.title, identity.replace("v3", "v2")), false);
    assert.equal(clean.description, diagnostic.description);
    for (const diagnosticTitle of [false, true]) {
        const long = composeUploadMetadata(recording, { output: { ...description.output, title: "Natural title ".repeat(100) } },
            provenance, "full", { diagnosticTitle });
        assert(long.title.length <= 255);
        assert.equal(hasDiagnosticUploadIdentity(long.title, identity), diagnosticTitle);
    }
});

test("orchestrator enables diagnostic titles only for a prepared comparison trial", async (t) => {
    const { root } = await rootFixture(t);
    for (const comparison of [false, true]) {
        const db = new PipelineDatabase(path.join(root, `titles-${comparison}.sqlite`));
        try {
            if (comparison) db.prepareComparisonTrial();
            const recording = db.discover(input(root, "fc2", "2026-09-09 120000 12345"));
            db.saveProvenance(recording.id, { observedIdentifier: "12345", status: "resolved", streamerId: "12345",
                alias: "12345", streamerUrl: "https://live.fc2.com/12345/", aliasUrl: null, reason: null,
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
                ? "Natural public title [2026-09-09 120000 12345 | production-v3 | full]" : "Natural public title");
        } finally { db.close(); }
    }
});

test("submitted provider ID is independent of title and refuses ambiguous/foreign edit links", () => {
    const base = "https://www.xvideos.com/account/uploads/new";
    assert.equal(submittedUploadEditId(base, ["/account/uploads/123/edit"]), "123");
    assert.equal(submittedUploadEditId(base, ["/account/uploads/123/edit", "/account/uploads/123/edit"]), "123");
    assert.equal(submittedUploadEditId(base, ["/account/uploads/123/edit", "/account/uploads/456/edit"]), null);
    assert.equal(submittedUploadEditId(base, ["https://other.test/account/uploads/123/edit"]), null);
    assert.equal(submittedUploadEditId("https://www.xvideos.com/account/uploads/123/edit", ["/account/uploads/456/edit"]), "123");
});

test("clean-title missing-ID recovery never searches descriptive titles; diagnostic ambiguity is not adopted", async (t) => {
    const uploader = new ChromiumXvideosUploader({});
    let searches = 0;
    uploader.findEntries = async () => { searches++; return [
        { remoteId: "1", title: "Natural title [identity]" },
        { remoteId: "2", title: "Another title [identity]" },
    ]; };
    // Jump past the panel polling deadline, without opening a browser or waiting.
    let now = 0;
    t.mock.method(Date, "now", () => { now += 400_000; return now; });
    assert.equal(await uploader.captureSubmittedVideoId({}, null), null);
    assert.equal(searches, 0);
    assert.equal(await uploader.captureSubmittedVideoId({}, "identity"), null);
    assert.equal(searches, 1);
    uploader.findEntries = async () => [{ remoteId: "3", title: "Natural title [identity]" }];
    assert.equal(await uploader.captureSubmittedVideoId({}, "identity"), "3");
});

test("uploads-list matching filters entries by title search term", () => {
    const entries = filterXvideosEntries([{
        containerId: "listing-video-85165541",
        remoteUrl: "https://www.xvideos.com/video.example/title",
        title: "Specific title [fc2-deadbeef1234]",
    }, {
        containerId: "listing-video-99999999",
        remoteUrl: "https://www.xvideos.com/video.example/other",
        title: "Unrelated title",
    }], "[fc2-deadbeef1234]");
    assert.deepEqual(entries, [{
        remoteId: "85165541",
        remoteUrl: "https://www.xvideos.com/video.example/title",
        title: "Specific title [fc2-deadbeef1234]",
    }]);
});

test("one manual alias override resolves every matching recording and survives refreshes", async (t) => {
    const { root } = await rootFixture(t);
    const database = new PipelineDatabase(path.join(root, "manual.sqlite"));
    t.after(() => database.close());
    const first = database.discover(input(root, "sc", "2026-08-13 101112 old_name"));
    const second = database.discover(input(root, "sc", "2026-08-14 121314 old_name"));
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
        streamerUrl: "https://stripchat.com/123456",
        aliasUrl: "https://stripchat.com/current_name",
    });
    assert.equal(database.getProvenance(first.id)?.status, "manual");
    assert.equal(database.getProvenance(second.id)?.streamerId, "123456");
    const override = database.getProvenanceOverride("sc", "old_name");
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
    const recording = database.discover(input(root, "fc2", "2026-08-13 101112 68190398"));
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
        streamerUrl: "https://live.fc2.com/68190398/",
        aliasUrl: null,
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    database.saveUploadMetadata(recording.id, {
        title: "Specific title [2026-08-13 101112 68190398]",
        description: "Specific concrete description.\n\nSource: https://live.fc2.com/68190398/",
        tags: ["fc2", "live"],
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
                tags: ["fc2", "live"],
                visibility: "private",
            },
            now,
        ),
        /locator.fill timed out mid-flight/,
    );
    // The run must NOT drop back to metadata_ready for an immediate retry that
    // would re-upload the file: it stays uncertain until a reconciliation pass
    // confirms whether the upload landed.
    assert.equal(database.get(recording.id)?.state, "xvideos_uncertain");
    assert.equal(database.dueUploadConfirmations(new Date("2026-08-14T08:00:00Z")).length, 1);
});

test("the upload identity guard refuses unverified and cleans verified recordings", async (t) => {
    const { root } = await rootFixture(t);
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const recording = database.discover(input(root, "fc2", "2026-08-13 101112 68190398"));
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
        streamerUrl: "https://live.fc2.com/68190398/",
        aliasUrl: null,
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    database.saveUploadMetadata(recording.id, {
        title: "Specific title [2026-08-13 101112 68190398]",
        description: "Specific concrete description.\n\nSource: https://live.fc2.com/68190398/",
        tags: ["fc2", "live"],
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
    database.reconcileUncertain(attemptId, "91362268", "https://www.xvideos.com/video.abc123/title", now);
    database.markRemoteVerified(recording.id, "91362268", "https://www.xvideos.com/video.abc123/title", now);
    assert.equal(confirmation.attemptId, attemptId);
    const verified = await guardUploadIdentity(database, database.get(recording.id), { cleanupEnabled: true });
    assert.deepEqual(verified, {
        kind: "verified_cleaned",
        remoteId: "91362268",
        remoteUrl: "https://www.xvideos.com/video.abc123/title",
    });
    assert.equal(database.get(recording.id)?.state, "cleanup_eligible");
    await assert.rejects(access(artifactPath), /ENOENT/);
});
