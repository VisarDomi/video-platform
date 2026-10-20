import assert from "node:assert/strict";
import test from "node:test";
import {
    PROVIDER_UPLOAD_POLICIES,
    SHARED_UPLOAD_POLICY,
    UPLOAD_PROVIDER_PLAN,
    deriveSharedUploadPolicy,
} from "../dist/services/upload/uploadPolicy.js";
import {
    assessFinalArtifact,
    assessRecording,
    planRecordingsForUpload,
} from "../dist/services/upload/uploadPlanner.js";

const candidate = {
    id: "tango:example",
    path: "/videos/example/playlist.m3u8",
    durationSeconds: 180,
};

test("shared limits are derived from provider policies", () => {
    assert.deepEqual(UPLOAD_PROVIDER_PLAN, {
        primary: "porntrex",
        backups: [],
        unavailableBackups: [{
            provider: "bunkr",
            reason: "Registrations are closed until further notice.",
        }],
    });
    assert.deepEqual(SHARED_UPLOAD_POLICY.providers, ["porntrex"]);
    assert.equal(SHARED_UPLOAD_POLICY.minimumDurationSeconds, 120);
    assert.equal(SHARED_UPLOAD_POLICY.maximumDurationSeconds, null);
    assert.equal(SHARED_UPLOAD_POLICY.maximumFileBytes, 10_000_000_000);
    assert.deepEqual(Object.keys(PROVIDER_UPLOAD_POLICIES).sort(), ["bunkr", "porntrex"]);
    assert.equal(PROVIDER_UPLOAD_POLICIES.porntrex.uploadVisibility, "public");
    assert.equal(PROVIDER_UPLOAD_POLICIES.bunkr.inactiveDeletionDays, 30);
    assert.equal(PROVIDER_UPLOAD_POLICIES.bunkr.maintenanceVisitIntervalDays, 15);

    const changedBunkrLimit = {
        ...PROVIDER_UPLOAD_POLICIES.bunkr,
        maximumFileBytes: 900_000_000,
    };
    assert.equal(
        deriveSharedUploadPolicy([PROVIDER_UPLOAD_POLICIES.porntrex, changedBunkrLimit]).maximumFileBytes,
        900_000_000,
    );
});

test("the Porntrex minimum duration is inclusive", () => {
    const shortCandidate = { ...candidate, durationSeconds: 120 };
    const assessment = assessRecording(shortCandidate);

    assert.deepEqual(assessment, {
        candidate: shortCandidate,
        disposition: "ready_for_description",
        sourceAction: "none",
    });
});

test("Porntrex has no maximum duration", () => {
    const atLimit = { ...candidate, durationSeconds: 7_200 };
    const overLimit = { ...candidate, durationSeconds: 7_200.001 };

    assert.equal(assessRecording(atLimit).disposition, "ready_for_description");
    assert.equal(assessRecording(overLimit).disposition, "ready_for_description");
    assert.equal(assessRecording(overLimit).notification, undefined);
    assert.equal(assessRecording(overLimit).sourceAction, "none");
});

test("a shared policy can override the minimum duration", () => {
    const verifiedPolicy = { ...SHARED_UPLOAD_POLICY, minimumDurationSeconds: 60 };
    const belowMinimum = { ...candidate, durationSeconds: 59 };
    const atMinimum = { ...candidate, durationSeconds: 60 };

    assert.equal(assessRecording(belowMinimum, verifiedPolicy).disposition, "skipped_too_short");
    assert.equal(assessRecording(belowMinimum, verifiedPolicy).notification?.code, "too_short");
    assert.deepEqual(assessRecording(atMinimum, verifiedPolicy), {
        candidate: atMinimum,
        disposition: "ready_for_description",
        sourceAction: "none",
    });
});

test("bulk planning excludes recordings below the provider minimum", () => {
    const shortOne = { ...candidate, id: "short-one", durationSeconds: 30 };
    const ready = { ...candidate, id: "ready", durationSeconds: 1_200 };
    const shortTwo = { ...candidate, id: "short-two", durationSeconds: 179 };

    const plan = planRecordingsForUpload([shortOne, ready, shortTwo]);

    assert.equal(plan.strategy, "one_recording_per_upload");
    assert.deepEqual(plan.readyCandidates, [ready, shortTwo]);
    assert.equal(plan.notifications.length, 1);
    assert(plan.assessments.every((assessment) => assessment.sourceAction === "none"));
});

test("the final artifact size limit is inclusive", () => {
    const atLimit = { ...candidate, path: "/videos/example.mp4", sizeBytes: 10_000_000_000 };
    const overLimit = { ...atLimit, sizeBytes: 10_000_000_001 };

    assert.equal(assessFinalArtifact(atLimit).disposition, "ready_for_upload");
    assert.equal(assessFinalArtifact(overLimit).disposition, "blocked_too_large");
    assert.equal(assessFinalArtifact(overLimit).sourceAction, "none");
    assert.equal(assessFinalArtifact(overLimit).notification?.code, "too_large");
});

test("invalid metadata is blocked and reported", () => {
    assert.equal(
        assessRecording({ ...candidate, durationSeconds: 0 }).notification?.code,
        "invalid_duration",
    );
    assert.equal(
        assessFinalArtifact({ ...candidate, sizeBytes: 0 }).notification?.code,
        "invalid_size",
    );
});
