// The limits one destination sets on an upload (its plug-in's policy), as the planner
// applies them; the destination's ID names it in the notifications.
export interface UploadLimits {
    readonly destination: string;
    // Shorter recordings wait to be joined with compatible footage (null: no minimum).
    readonly minimumDurationSeconds: number | null;
    readonly maximumDurationSeconds: number | null;
    readonly maximumFileBytes: number;
}

export interface UploadCandidate {
    readonly id: string;
    readonly path: string;
    readonly durationSeconds: number;
}

export interface FinalUploadArtifact extends UploadCandidate {
    readonly sizeBytes: number;
}

export type UploadDisposition =
    | "ready_for_description"
    | "ready_for_upload"
    | "skipped_too_short"
    | "blocked_too_long"
    | "blocked_too_large"
    | "blocked_invalid_metadata";

export interface UploadNotification {
    readonly candidateId: string;
    readonly severity: "warning" | "error";
    readonly code: "too_short" | "too_long" | "too_large" | "invalid_duration" | "invalid_size";
    readonly message: string;
    readonly requiresManualAction: true;
}

export interface UploadAssessment<TCandidate extends UploadCandidate> {
    readonly candidate: TCandidate;
    readonly disposition: UploadDisposition;
    readonly sourceAction: "none";
    readonly notification?: UploadNotification;
}

export interface RecordingUploadPlan {
    readonly strategy: "one_recording_per_upload";
    readonly assessments: readonly UploadAssessment<UploadCandidate>[];
    readonly readyCandidates: readonly UploadCandidate[];
    readonly notifications: readonly UploadNotification[];
}

function invalidPositiveNumber(value: number): boolean {
    return !Number.isFinite(value) || value <= 0;
}

export function assessRecording(
    candidate: UploadCandidate,
    policy: UploadLimits,
): UploadAssessment<UploadCandidate> {
    if (invalidPositiveNumber(candidate.durationSeconds)) {
        return {
            candidate,
            disposition: "blocked_invalid_metadata",
            sourceAction: "none",
            notification: {
                candidateId: candidate.id,
                severity: "error",
                code: "invalid_duration",
                message: `Cannot plan ${candidate.path}: duration is not a valid positive number.`,
                requiresManualAction: true,
            },
        };
    }
    if (policy.minimumDurationSeconds !== null && candidate.durationSeconds < policy.minimumDurationSeconds) {
        return {
            candidate,
            disposition: "skipped_too_short",
            sourceAction: "none",
            notification: {
                candidateId: candidate.id,
                severity: "warning",
                code: "too_short",
                message: `Skipped ${candidate.path}: ${candidate.durationSeconds.toFixed(3)}s is below the ${policy.destination} ${policy.minimumDurationSeconds}s minimum.`,
                requiresManualAction: true,
            },
        };
    }
    if (policy.maximumDurationSeconds !== null && candidate.durationSeconds > policy.maximumDurationSeconds) {
        return {
            candidate,
            disposition: "blocked_too_long",
            sourceAction: "none",
            notification: {
                candidateId: candidate.id,
                severity: "warning",
                code: "too_long",
                message: `Blocked ${candidate.path}: ${candidate.durationSeconds.toFixed(3)}s exceeds the ${policy.destination} ${policy.maximumDurationSeconds}s maximum.`,
                requiresManualAction: true,
            },
        };
    }
    return { candidate, disposition: "ready_for_description", sourceAction: "none" };
}

export function planRecordingsForUpload(
    candidates: readonly UploadCandidate[],
    policy: UploadLimits,
): RecordingUploadPlan {
    const assessments = candidates.map((candidate) => assessRecording(candidate, policy));
    return {
        strategy: "one_recording_per_upload",
        assessments,
        readyCandidates: assessments
            .filter((assessment) => assessment.disposition === "ready_for_description")
            .map((assessment) => assessment.candidate),
        notifications: assessments.flatMap((assessment) => assessment.notification ? [assessment.notification] : []),
    };
}

export function assessFinalArtifact(
    artifact: FinalUploadArtifact,
    policy: UploadLimits,
): UploadAssessment<FinalUploadArtifact> {
    const recordingAssessment = assessRecording(artifact, policy);
    if (recordingAssessment.disposition !== "ready_for_description") {
        return {
            candidate: artifact,
            disposition: recordingAssessment.disposition,
            sourceAction: "none",
            notification: recordingAssessment.notification,
        };
    }
    if (invalidPositiveNumber(artifact.sizeBytes)) {
        return {
            candidate: artifact,
            disposition: "blocked_invalid_metadata",
            sourceAction: "none",
            notification: {
                candidateId: artifact.id,
                severity: "error",
                code: "invalid_size",
                message: `Cannot upload ${artifact.path}: size is not a valid positive number.`,
                requiresManualAction: true,
            },
        };
    }
    if (artifact.sizeBytes > policy.maximumFileBytes) {
        return {
            candidate: artifact,
            disposition: "blocked_too_large",
            sourceAction: "none",
            notification: {
                candidateId: artifact.id,
                severity: "warning",
                code: "too_large",
                message: `Blocked ${artifact.path}: ${artifact.sizeBytes} bytes exceeds the ${policy.destination} ${policy.maximumFileBytes}-byte maximum.`,
                requiresManualAction: true,
            },
        };
    }
    return { candidate: artifact, disposition: "ready_for_upload", sourceAction: "none" };
}
