import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { composeUploadMetadata } from "../dist/metadata/composeUploadMetadata.js";
import { TargetCatalogResolver } from "../dist/provenance/targetResolver.js";
import { findXvideosEntry } from "../dist/upload/xvideosEntries.js";
import { hasModelSelection } from "../dist/upload/chromiumXvideosUploader.js";
import { UploadCoordinator } from "../dist/upload/uploadCoordinator.js";

async function rootFixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-upload-flow-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "targets"));
    await writeFile(path.join(root, "targets", "tango.txt"), "https://tango.me/account-id current_alias\n");
    await writeFile(path.join(root, "targets", "fc2.txt"), "https://live.fc2.com/68190398/\n");
    await writeFile(path.join(root, "targets", "sc.txt"), "https://stripchat.com/Minami_jjjj 226494362\n");
    await writeFile(path.join(root, "aliases.json"), JSON.stringify({
        "account-id": ["old_alias", "current_alias"],
    }));
    const resolver = await TargetCatalogResolver.load({
        targetFiles: {
            tango: path.join(root, "targets", "tango.txt"),
            fc2: path.join(root, "targets", "fc2.txt"),
            sc: path.join(root, "targets", "sc.txt"),
        },
        tangoAliasesPath: path.join(root, "aliases.json"),
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

test("canonical target resolution uses Tango API alias history and current FC2/SC targets", async (t) => {
    const { root, resolver } = await rootFixture(t);
    const tango = resolver.resolve(input(root, "tango", "2026-08-13 101112 old_alias"));
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
    assert.equal(resolver.resolve(input(root, "fc2", "2026-08-13 101112 68190398")).status, "resolved");
    assert.equal(resolver.resolve(input(root, "sc", "2026-08-13 101112 Minami_jjjj")).streamerId, "226494362");
    assert.equal(
        resolver.resolve(input(root, "sc", "2026-08-13 101112 previous_sc_alias")).status,
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
    assert.equal(metadata.matchKey, "[2026-08-13 101112 Minami_jjjj]");
    assert(metadata.title.includes("[2026-08-13 101112 Minami_jjjj]"));
    assert(metadata.description.includes("Recorded: 2026-08-13 10:11:12"));
    assert(metadata.description.includes("Source: https://stripchat.com/226494362"));
    assert(metadata.description.includes("Alias: https://stripchat.com/Minami_jjjj"));
    assert(metadata.description.length <= 1_000);
});

test("uploads-list matching adopts blocked entries by stable numeric ID", () => {
    const entry = findXvideosEntry([{
        containerId: "listing-video-85165541",
        remoteUrl: "https://www.xvideos.com/video.example/title",
        title: "Specific title [fc2-deadbeef1234]",
        text: "Status: Blocked for reason: Stolen private content\nViews: 0",
    }], "[fc2-deadbeef1234]");
    assert.deepEqual(entry, {
        remoteId: "85165541",
        remoteUrl: "https://www.xvideos.com/video.example/title",
        title: "Specific title [fc2-deadbeef1234]",
        moderationStatus: "Blocked for reason: Stolen private content",
    });
});

test("manual XVideos model selection waits for a nonempty form selection", () => {
    assert.equal(hasModelSelection(""), false);
    assert.equal(hasModelSelection("[]"), false);
    assert.equal(hasModelSelection("{}"), false);
    assert.equal(hasModelSelection('[{"id":"123","name":"stage"}]'), true);
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

test("uncertain metadata submission cannot retry before 24 hours and becomes retryable only after absence", async (t) => {
    const { root } = await rootFixture(t);
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const recording = database.discover(input(root, "fc2", "2026-08-13 101112 68190398"));
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
        streamerUrl: "https://live.fc2.com/68190398/",
        aliasUrl: null,
        reason: null,
        updatedAt: "2026-08-13T08:00:00Z",
    });
    const matchKey = `[fc2-${recording.id.slice(0, 12)}]`;
    database.saveUploadMetadata(recording.id, {
        title: `Specific title ${matchKey}`,
        description: "Specific concrete description.\n\nSource: https://live.fc2.com/68190398/",
        tags: ["fc2", "live"],
        matchKey,
    });
    const submittedAt = new Date("2026-08-13T08:00:00Z");
    const reservation = database.reserveUpload(recording.id, 100, submittedAt);
    const attempt = database.beginUpload(recording.id, reservation, submittedAt);
    database.finishUploadAttempt(attempt, {
        status: "uncertain",
        transmittedBytes: 100,
        error: "entry not visible immediately",
        confirmation: { matchKey, confirmAfter: new Date("2026-08-14T08:00:00Z") },
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
    const matchKey = "[2026-08-13 101112 68190398]";
    database.saveUploadMetadata(recording.id, {
        title: `Specific title ${matchKey}`,
        description: "Specific concrete description.\n\nSource: https://live.fc2.com/68190398/",
        tags: ["fc2", "live"],
        matchKey,
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
                title: `Specific title ${matchKey}`,
                description: "Specific concrete description.",
                tags: ["fc2", "live"],
                matchKey,
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
