import assert from "node:assert/strict";
import test from "node:test";
import { assessFinalArtifact, assessRecording, planRecordingsForUpload } from "../dist/index.js";

// A destination's limits, as its plug-in declares them.
const limits = { destination: "form-host", minimumDurationSeconds: 120, maximumDurationSeconds: null, maximumFileBytes: 10_000_000_000 };
const candidate = { id: "live-a:example", path: "/videos/example/playlist.m3u8", durationSeconds: 180 };

test("the minimum duration is inclusive, and a shorter recording names the destination", () => {
    const atMinimum = { ...candidate, durationSeconds: 120 };
    assert.deepEqual(assessRecording(atMinimum, limits), { candidate: atMinimum, disposition: "ready_for_description", sourceAction: "none" });
    const short = assessRecording({ ...candidate, durationSeconds: 119.9 }, limits);
    assert.equal(short.disposition, "skipped_too_short");
    assert.equal(short.notification?.code, "too_short");
    assert.match(short.notification?.message ?? "", /below the form-host 120s minimum/);
});

test("no maximum duration means any length", () => {
    const long = { ...candidate, durationSeconds: 6 * 3600 };
    assert.equal(assessRecording(long, limits).disposition, "ready_for_description");
    assert.equal(assessRecording(long, limits).notification, undefined);
});

test("a maximum duration blocks longer recordings for review", () => {
    const capped = { ...limits, maximumDurationSeconds: 7_200 };
    assert.equal(assessRecording({ ...candidate, durationSeconds: 7_200 }, capped).disposition, "ready_for_description");
    const over = assessRecording({ ...candidate, durationSeconds: 7_200.001 }, capped);
    assert.equal(over.disposition, "blocked_too_long");
    assert.equal(over.sourceAction, "none");
});

test("bulk planning excludes recordings below the minimum", () => {
    const shortOne = { ...candidate, id: "short-one", durationSeconds: 30 };
    const ready = { ...candidate, id: "ready", durationSeconds: 1_200 };
    const shortTwo = { ...candidate, id: "short-two", durationSeconds: 179 };
    const plan = planRecordingsForUpload([shortOne, ready, shortTwo], limits);
    assert.equal(plan.strategy, "one_recording_per_upload");
    assert.deepEqual(plan.readyCandidates, [ready, shortTwo]);
    assert.equal(plan.notifications.length, 1);
    assert(plan.assessments.every((assessment) => assessment.sourceAction === "none"));
});

test("the final artifact size limit is inclusive", () => {
    const atLimit = { ...candidate, path: "/videos/example.mp4", sizeBytes: 10_000_000_000 };
    const overLimit = { ...atLimit, sizeBytes: 10_000_000_001 };
    assert.equal(assessFinalArtifact(atLimit, limits).disposition, "ready_for_upload");
    const blocked = assessFinalArtifact(overLimit, limits);
    assert.equal(blocked.disposition, "blocked_too_large");
    assert.equal(blocked.sourceAction, "none");
    assert.equal(blocked.notification?.code, "too_large");
    assert.match(blocked.notification?.message ?? "", /form-host 10000000000-byte maximum/);
});

test("invalid metadata is blocked and reported", () => {
    assert.equal(assessRecording({ ...candidate, durationSeconds: 0 }, limits).notification?.code, "invalid_duration");
    assert.equal(assessFinalArtifact({ ...candidate, sizeBytes: 0 }, limits).notification?.code, "invalid_size");
});
