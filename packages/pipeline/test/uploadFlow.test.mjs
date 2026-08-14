import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { composeUploadMetadata } from "../dist/metadata/composeUploadMetadata.js";
import { TargetCatalogResolver } from "../dist/provenance/targetResolver.js";
import { findOldHostEntry } from "../dist/upload/oldhostEntries.js";
import { hasModelSelection } from "../dist/upload/chromiumOldHostUploader.js";

async function rootFixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-upload-flow-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "targets"));
    await writeFile(path.join(root, "targets", "tslive.txt"), "https://ts-live.example/account-id current_alias\n");
    await writeFile(path.join(root, "targets", "ladder.txt"), "https://ladder-live.example/68190398/\n");
    await writeFile(path.join(root, "targets", "fmp4.txt"), "https://fmp4-live.example/channel-561 226494362\n");
    await writeFile(path.join(root, "aliases.json"), JSON.stringify({
        "account-id": ["old_alias", "current_alias"],
    }));
    const resolver = await TargetCatalogResolver.load({
        targetFiles: {
            tslive: path.join(root, "targets", "tslive.txt"),
            ladder: path.join(root, "targets", "ladder.txt"),
            fmp4: path.join(root, "targets", "fmp4.txt"),
        },
        tsliveAliasesPath: path.join(root, "aliases.json"),
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

test("canonical target resolution uses TsLive API alias history and current LADDER/FMP4 targets", async (t) => {
    const { root, resolver } = await rootFixture(t);
    const tslive = resolver.resolve(input(root, "tslive", "2026-08-13 101112 old_alias"));
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
    assert.equal(resolver.resolve(input(root, "ladder", "2026-08-13 101112 68190398")).status, "resolved");
    assert.equal(resolver.resolve(input(root, "fmp4", "2026-08-13 101112 channel-561")).streamerId, "226494362");
    assert.equal(
        resolver.resolve(input(root, "fmp4", "2026-08-13 101112 previous_fmp4_alias")).status,
        "review_required",
    );
});

test("metadata reserves provenance room and prepends provider/live before normalized descriptor tags", async (t) => {
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
            title: "Player serves on a sunlit grass court",
            description: "A player stands on the baseline and speaks to the camera. She changes position and adjusts her racket.",
            tags: ["Live", "Singles", "grass", "singles"],
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
    assert.deepEqual(metadata.tags, ["fmp4live", "live", "singles", "grass"]);
    assert(metadata.title.includes("[fmp4-aaaaaaaaaaaa]"));
    assert(metadata.description.includes("Recorded: 2026-08-13 10:11:12"));
    assert(metadata.description.includes("Source: https://fmp4-live.example/226494362"));
    assert(metadata.description.includes("Alias: https://fmp4-live.example/channel-561"));
    assert(metadata.description.length <= 1_000);
});

test("uploads-list matching adopts blocked entries by stable numeric ID", () => {
    const entry = findOldHostEntry([{
        containerId: "listing-video-85165541",
        remoteUrl: "https://old-host.example/video.example/title",
        title: "Specific title [ladder-deadbeef1234]",
        text: "Status: Blocked for reason: Stolen private content\nViews: 0",
    }], "[ladder-deadbeef1234]");
    assert.deepEqual(entry, {
        remoteId: "85165541",
        remoteUrl: "https://old-host.example/video.example/title",
        title: "Specific title [ladder-deadbeef1234]",
        moderationStatus: "Blocked for reason: Stolen private content",
    });
});

test("manual OldHost model selection waits for a nonempty form selection", () => {
    assert.equal(hasModelSelection(""), false);
    assert.equal(hasModelSelection("[]"), false);
    assert.equal(hasModelSelection("{}"), false);
    assert.equal(hasModelSelection('[{"id":"123","name":"stage"}]'), true);
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
    const matchKey = `[ladder-${recording.id.slice(0, 12)}]`;
    database.saveUploadMetadata(recording.id, {
        title: `Specific title ${matchKey}`,
        description: "Specific concrete description.\n\nSource: https://ladder-live.example/68190398/",
        tags: ["ladder", "live"],
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
