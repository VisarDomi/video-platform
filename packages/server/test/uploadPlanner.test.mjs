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
        primary: "xvideos",
        backups: [],
        unavailableBackups: [{
            provider: "bunkr",
            reason: "Registrations are closed until further notice.",
        }],
    });
    assert.deepEqual(SHARED_UPLOAD_POLICY.providers, ["xvideos"]);
    assert.equal(SHARED_UPLOAD_POLICY.minimumDurationSeconds, null);
    assert.equal(SHARED_UPLOAD_POLICY.maximumDurationSeconds, 7_200);
    assert.equal(SHARED_UPLOAD_POLICY.maximumFileBytes, 50_000_000_000);
    assert(SHARED_UPLOAD_POLICY.unresolvedConstraints.includes("xvideos.minimumDurationSeconds"));
    assert.equal(PROVIDER_UPLOAD_POLICIES.xvideos.uploadVisibility, "private");
    assert.equal(PROVIDER_UPLOAD_POLICIES.bunkr.inactiveDeletionDays, 30);
    assert.equal(PROVIDER_UPLOAD_POLICIES.bunkr.maintenanceVisitIntervalDays, 15);

    const changedBunkrLimit = {
        ...PROVIDER_UPLOAD_POLICIES.bunkr,
        maximumFileBytes: 900_000_000,
    };
    assert.equal(
        deriveSharedUploadPolicy([PROVIDER_UPLOAD_POLICIES.xvideos, changedBunkrLimit]).maximumFileBytes,
        900_000_000,
    );
});

test("short recordings proceed while the XVideos minimum is unresolved", () => {
    const shortCandidate = { ...candidate, durationSeconds: 1 };
    const assessment = assessRecording(shortCandidate);

    assert.deepEqual(assessment, {
        candidate: shortCandidate,
        disposition: "ready_for_description",
        sourceAction: "none",
    });
});

test("the two-hour maximum duration is inclusive", () => {
    const atLimit = { ...candidate, durationSeconds: 7_200 };
    const overLimit = { ...candidate, durationSeconds: 7_200.001 };

    assert.equal(assessRecording(atLimit).disposition, "ready_for_description");
    assert.equal(assessRecording(overLimit).disposition, "blocked_too_long");
    assert.equal(assessRecording(overLimit).notification?.code, "too_long");
    assert.equal(assessRecording(overLimit).sourceAction, "none");
});

test("a minimum can be enabled globally after the manual XVideos check", () => {
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

test("bulk planning keeps short recordings independent while the minimum is unresolved", () => {
    const shortOne = { ...candidate, id: "short-one", durationSeconds: 30 };
    const ready = { ...candidate, id: "ready", durationSeconds: 1_200 };
    const shortTwo = { ...candidate, id: "short-two", durationSeconds: 179 };

    const plan = planRecordingsForUpload([shortOne, ready, shortTwo]);

    assert.equal(plan.strategy, "one_recording_per_upload");
    assert.deepEqual(plan.readyCandidates, [shortOne, ready, shortTwo]);
    assert.deepEqual(plan.notifications, []);
    assert(plan.assessments.every((assessment) => assessment.sourceAction === "none"));
});

test("the final artifact size limit is inclusive", () => {
    const atLimit = { ...candidate, path: "/videos/example.mp4", sizeBytes: 50_000_000_000 };
    const overLimit = { ...atLimit, sizeBytes: 50_000_000_001 };

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
