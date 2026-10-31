import { assessFinalArtifact, policyForUploadProvider } from "shared";
import type { ActiveUploadProvider } from "../config/uploadProviders.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import { DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES, REQUEST_OVERHEAD_RESERVATION_BYTES } from "../domain/uploadBudget.js";
import { RESOLUTION_POLICY_VERSION } from "../stages/resolutionPolicy.js";
import { CURRENT_PRODUCTION_VERSION } from "../domain/productionVersion.js";
import { isDirectArtifactPath } from "../stages/remux.js";

export interface DryRunUploadItem {
    readonly recordingId: string;
    readonly artifactPath: string | null;
    readonly sizeBytes: number | null;
    readonly disposition: "would_upload" | "blocked";
    readonly reason: string | null;
}

export function createDryRunUploadPlan(
    database: PipelineDatabase,
    now = new Date(),
    timeZone = "Europe/Tirane",
    monthlyLimitBytes = DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES,
    stagingRoot?: string,
    provider: ActiveUploadProvider = "porntrex",
): DryRunUploadItem[] {
    let simulatedReserved = 0;
    const budget = database.uploadBudget(now, timeZone, monthlyLimitBytes);
    return database.list("metadata_ready").map((recording) => {
        if (!database.canAttemptUpload(recording.id, now)) {
            return { recordingId: recording.id, artifactPath: database.getArtifact(recording.id)?.path ?? null,
                sizeBytes: database.getArtifact(recording.id)?.sizeBytes ?? null,
                disposition: "blocked" as const, reason: "weekly_upload_retry_wait" };
        }
        if (recording.sourceKind !== "edited") {
            return {
                recordingId: recording.id,
                artifactPath: database.getArtifact(recording.id)?.path ?? null,
                sizeBytes: database.getArtifact(recording.id)?.sizeBytes ?? null,
                disposition: "blocked" as const,
                reason: "source_not_edited",
            };
        }
        if (!database.hasResolutionPolicyAssessment(recording.id, RESOLUTION_POLICY_VERSION)) {
            const artifact = database.getArtifact(recording.id);
            return {
                recordingId: recording.id,
                artifactPath: artifact?.path ?? null,
                sizeBytes: artifact?.sizeBytes ?? null,
                disposition: "blocked" as const,
                reason: "resolution_policy_unassessed",
            };
        }
        const artifact = database.getArtifact(recording.id);
        if (!artifact) {
            return {
                recordingId: recording.id,
                artifactPath: null,
                sizeBytes: null,
                disposition: "blocked" as const,
                reason: "missing_artifact",
            };
        }
        if (database.getProductionVersion() !== CURRENT_PRODUCTION_VERSION
            || (stagingRoot !== undefined && !isDirectArtifactPath(stagingRoot, artifact.path))) {
            return {
                recordingId: recording.id,
                artifactPath: artifact.path,
                sizeBytes: artifact.sizeBytes,
                disposition: "blocked" as const,
                reason: "artifact_generation_mismatch",
            };
        }
        const assessment = assessFinalArtifact({
            id: recording.id,
            path: artifact.path,
            durationSeconds: recording.durationSeconds,
            sizeBytes: artifact.sizeBytes,
        }, policyForUploadProvider(provider));
        if (assessment.disposition !== "ready_for_upload") {
            return {
                recordingId: recording.id,
                artifactPath: artifact.path,
                sizeBytes: artifact.sizeBytes,
                disposition: "blocked" as const,
                reason: `${provider}: ${assessment.disposition}; ${assessment.notification?.message ?? "manual review required"}`,
            };
        }
        const reservedBytes = artifact.sizeBytes + REQUEST_OVERHEAD_RESERVATION_BYTES;
        if (simulatedReserved + reservedBytes > budget.remainingBytes) {
            return {
                recordingId: recording.id,
                artifactPath: artifact.path,
                sizeBytes: artifact.sizeBytes,
                disposition: "blocked" as const,
                reason: "monthly_upload_limit",
            };
        }
        simulatedReserved += reservedBytes;
        return {
            recordingId: recording.id,
            artifactPath: artifact.path,
            sizeBytes: artifact.sizeBytes,
            disposition: "would_upload" as const,
            reason: null,
        };
    });
}
