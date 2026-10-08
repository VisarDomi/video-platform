import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { pipelineConfig } from "../dist/config.js";
import { reconcileDueUploads } from "../dist/commands/reconcileUploads.js";
import { retryRecording } from "../dist/commands/retryRecording.js";
import { uploadOne } from "../dist/commands/uploadOne.js";
import { composeUploadMetadata } from "../dist/metadata/composeUploadMetadata.js";
import { RESOLUTION_POLICY_VERSION } from "../dist/stages/resolutionPolicy.js";

const start = new Date("2026-09-20T08:23:10.171Z");
const day = n => new Date(start.getTime() + n * 86400000);

// A recording whose upload got the remote ID 91957324 and awaits verification.
async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-provider-removal-"));
    const config = { ...pipelineConfig, databasePath: path.join(root, "pipeline.sqlite"), networkUploadsEnabled: true, cleanupEnabled: false };
    const db = new PipelineDatabase(config.databasePath);
    t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
    const r = db.discover({ provider: "tango", sourceKind: "edited", sourcePath: path.join(root, "2025-11-22 125658 example"),
        playlistPath: path.join(root, "playlist.m3u8"), sourceFingerprint: "fingerprint", durationSeconds: 600 });
    db.recordResolutionPolicyAssessment(r.id, `${RESOLUTION_POLICY_VERSION}: test`, start);
    db.transition(r.id, "server_ready", "remuxed");
    db.saveArtifact(r.id, { path: path.join(root, "artifact.mp4"), sizeBytes: 100, sha256: "a".repeat(64), validatedAt: start.toISOString() });
    db.saveDescription(r.id, { artifactSha256: "a".repeat(64), promptVersion: "test", fps: 1,
        output: { title: "Natural model title", description: "Saved description" }, evidencePath: path.join(root, "evidence.json") });
    db.saveProvenance(r.id, { observedIdentifier: "example", status: "resolved", streamerId: "123", alias: "example",
        streamerUrl: "https://tango.me/123", aliasUrl: null, reason: null, updatedAt: start.toISOString() });
    db.saveUploadMetadata(r.id, composeUploadMetadata(r, db.getDescription(r.id), db.getProvenance(r.id)));
    const reservation = db.reserveUpload(r.id, 120, start);
    const attempt = db.beginUpload(r.id, reservation, start);
    db.updateUploadProgress(attempt, "metadata_submitting", 100, start);
    db.finishUploadAttempt(attempt, { status: "uncertain", transmittedBytes: 100,
        confirmation: { confirmAfter: day(1) } }, start);
    db.attachUncertainRemote(attempt, "91957324");
    return { db, config, r, attempt };
}

const removedBrowser = {
    withAuthenticatedPage: async run => run({}),
    lookupUpload: async () => assert.fail("a known remote ID needs no lookup"),
    probeUploadStatus: async () => ({ outcome: "missing", reason: "edit page 404" }),
};

test("a video the provider removed is blocked for manual review and recorded against that provider", async t => {
    const { db, config, r } = await fixture(t);
    await reconcileDueUploads(config, day(1), removedBrowser);
    const recording = db.get(r.id);
    assert.equal(recording.state, "blocked");
    assert.match(recording.blockReason, /^xvideos removed video 91957324 after upload \(edit page 404\)/);
    assert.match(recording.blockReason, /another upload provider/);
    assert.doesNotMatch(recording.blockReason, /re-uploads/);
    assert.deepEqual(db.providerRemovals(r.id).map(({ provider, remoteId }) => ({ provider, remoteId })),
        [{ provider: "xvideos", remoteId: "91957324" }]);
});

test("retry refuses while the provider that removed the video is active, and unblocks once another one is", async t => {
    const { db, config, r } = await fixture(t);
    await reconcileDueUploads(config, day(1), removedBrowser);
    assert.throws(() => retryRecording(db, r.id, day(2)), /xvideos removed .*91957324.*upload-provider:set/s);
    assert.equal(db.get(r.id).state, "blocked");
    db.setCampaignState("paused", day(2));
    db.replaceProviderInventory("xvideos", [], day(2));
    db.setActiveUploadProvider("porntrex", day(2));
    assert.equal(retryRecording(db, r.id, day(2)).state, "metadata_ready");
});

test("an upload to the provider that removed the video is blocked before any network request", async t => {
    const { db, config, r } = await fixture(t);
    await reconcileDueUploads(config, day(1), removedBrowser);
    // Unblocked by hand, bypassing the retry command's check.
    db.retryBlocked(r.id, day(2));
    const result = await uploadOne(r.id, config);
    assert.equal(result.disposition, "manual_review");
    assert.equal(db.get(r.id).state, "blocked");
    assert.match(db.get(r.id).blockReason, /^xvideos removed video 91957324/);
});

test("reopening an older ledger learns its provider removals, not the owner's own deletions", async t => {
    const { config, db, r, attempt } = await fixture(t);
    // Evidence as written before removals had their own table.
    db.recordUploadEvidence(attempt, { stage: "provider_removed", remoteId: "91957324",
        reason: "owner deleted the unrotated upload 91957324 for re-processing" }, day(1));
    db.recordUploadEvidence(attempt, { stage: "provider_removed", remoteId: "91957324",
        reason: "xvideos removed video 91957324 after upload (edit page 404)" }, day(1));
    assert.deepEqual(db.providerRemovals(r.id), []);
    const reopened = new PipelineDatabase(config.databasePath);
    t.after(() => reopened.close());
    assert.deepEqual(reopened.providerRemovals(r.id).map(({ provider, remoteId, reason }) => ({ provider, remoteId, reason })),
        [{ provider: "xvideos", remoteId: "91957324", reason: "xvideos removed video 91957324 after upload (edit page 404)" }]);
});
