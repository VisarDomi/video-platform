import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { UploadCoordinator } from "../dist/upload/uploadCoordinator.js";
import { acceptBelowFullHd } from "../dist/commands/acceptBelowFullHd.js";

// A published upload whose best version stays below Full-HD counts as backed up once the owner
// says so: it is verified as it is, with the marker in its evidence; anything else is refused.
async function uploaded(t, renditions, { remoteUrl = true } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "below-full-hd-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const database = new PipelineDatabase(path.join(directory, "pipeline.sqlite"));
    t.after(() => database.close());
    const sourcePath = path.join(directory, "one");
    const recording = database.discover({ provider: "live-a", sourceKind: "edited", sourcePath,
        playlistPath: path.join(sourcePath, "playlist.m3u8"), sourceFingerprint: "fingerprint-one", durationSeconds: 600 });
    database.transition(recording.id, "server_ready", "remuxed");
    database.saveArtifact(recording.id, { path: path.join(directory, "one.mp4"), sizeBytes: 500, sha256: "a".repeat(64), validatedAt: new Date().toISOString() });
    database.saveDescription(recording.id, { artifactSha256: "a".repeat(64), promptVersion: "v1", fps: 2,
        output: { title: "A title", description: "A description of the video.", tags: ["room"] }, evidencePath: path.join(directory, "e.json") });
    database.saveProvenance(recording.id, { observedIdentifier: "alias", status: "resolved", streamerId: "s", alias: "alias",
        streamerUrl: "https://live-a.example/s", aliasUrl: "https://live-a.example/alias", reason: null, updatedAt: new Date().toISOString() });
    database.saveUploadMetadata(recording.id, { title: "A title [one]", description: "A description.", tags: ["live-a"] });
    database.recordResolutionPolicyAssessment(recording.id, "test fixture");
    const now = new Date();
    const reservation = database.reserveUpload(recording.id, 550, now);
    const provider = database.reservationProvider(reservation);
    let attemptId;
    await new UploadCoordinator(database, { async upload(request) {
        await request.onEvidence?.({ stage: "metadata_prepared" });
        return { kind: "uploaded", receipt: { transmittedBytes: 500, submittedVideoId: "5001", metadataSubmittedAt: now.toISOString() } };
    } }).uploadAdmitted(recording.id, reservation, { recordingId: recording.id, artifactPath: path.join(directory, "one.mp4"), sizeBytes: 500,
        title: "A title [one]", description: "A description.", tags: ["live-a"], visibility: "private" }, now);
    attemptId = database.pendingUploadByRemoteId(provider, "5001").attemptId;
    database.recordUploadEvidence(attemptId, { stage: "playback_verification", remoteId: "5001", outcome: "not_ready",
        ...(remoteUrl ? { remoteUrl: "https://video-host.example/video/5001/a-title" } : {}), renditions, reason: "Published; no Full-HD tier yet" }, now);
    return { database, recording, provider, attemptId };
}
const config = { cleanupEnabled: true, stagingRoot: os.tmpdir() };

test("a published copy below Full-HD is verified as it is, with the marker; a dry run changes nothing", async (t) => {
    const { database, recording, provider } = await uploaded(t, [{ width: 900, height: 720, label: "720p HD" }, { width: 600, height: 480, label: "480p" }]);
    const preview = await acceptBelowFullHd(database, config, provider, ["5001"], false);
    assert.equal(preview.results[0].disposition, "would_accept");
    assert.equal(database.get(recording.id).state, "upload_uncertain");
    const applied = await acceptBelowFullHd(database, config, provider, ["5001"], true);
    assert.deepEqual(applied.results[0], { remoteId: "5001", recordingId: recording.id, disposition: "accepted_below_full_hd", best: { width: 900, height: 720, label: "720p HD" } });
    assert.equal(database.get(recording.id).state, "cleanup_eligible");
    assert.equal(database.pendingUploadByRemoteId(provider, "5001"), null, "its daily check has ended");
    // Applied again: it only finishes what an earlier run could not.
    assert.equal((await acceptBelowFullHd(database, config, provider, ["5001"], true)).results[0].disposition, "already_accepted");
});

test("an earlier run without cleanup is finished by the next: the conversion's hold is released and the recording backed up", async (t) => {
    const { database, recording, provider, attemptId } = await uploaded(t, [{ width: 960, height: 720 }]);
    database.database.prepare("UPDATE upload_artifact_receipts SET retention_hold = 'legacy published rendition remains uncertain; retain conversion' WHERE attempt_id = ?").run(attemptId);
    const first = await acceptBelowFullHd(database, { ...config, cleanupEnabled: false }, provider, ["5001"], true);
    assert.match(first.note, /cleanup is off/);
    assert.equal(database.get(recording.id).state, "upload_verified");
    assert.equal(database.database.prepare("SELECT retention_hold FROM upload_artifact_receipts WHERE attempt_id = ?").get(attemptId).retention_hold, null);
    assert.equal((await acceptBelowFullHd(database, config, provider, ["5001"], true)).results[0].disposition, "already_accepted");
    assert.equal(database.get(recording.id).state, "cleanup_eligible");
});

test("an unknown ID, a copy with a Full-HD version, or one the last check found unpublished is refused and stays pending", async (t) => {
    const fullHd = await uploaded(t, [{ width: 1920, height: 1080, label: "1080p" }]);
    assert.match((await acceptBelowFullHd(fullHd.database, config, fullHd.provider, ["5001"], true)).results[0].reason, /Full-HD version exists/);
    assert.equal(fullHd.database.get(fullHd.recording.id).state, "upload_uncertain");
    assert.match((await acceptBelowFullHd(fullHd.database, config, fullHd.provider, ["9999"], true)).results[0].reason, /no pending check/);
    const unpublished = await uploaded(t, [{ width: 900, height: 720 }], { remoteUrl: false });
    assert.match((await acceptBelowFullHd(unpublished.database, config, unpublished.provider, ["5001"], true)).results[0].reason, /no published, playable copy/);
    assert.equal(unpublished.database.get(unpublished.recording.id).state, "upload_uncertain");
});
