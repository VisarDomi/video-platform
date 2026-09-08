import { assessFinalArtifact } from "shared";
import { calendarMonth, type PipelineDatabase } from "../db/pipelineDatabase.js";
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
    monthlyLimitBytes = 600_000_000_000,
    stagingRoot?: string,
): DryRunUploadItem[] {
    let simulatedReserved = 0;
    return database.list("metadata_ready").map((recording) => {
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
        });
        if (assessment.disposition !== "ready_for_upload") {
            return {
                recordingId: recording.id,
                artifactPath: artifact.path,
                sizeBytes: artifact.sizeBytes,
                disposition: "blocked" as const,
                reason: assessment.disposition,
            };
        }
        const usage = database.uploadUsage(calendarMonth(now, timeZone));
        if (usage.spent + usage.reserved + simulatedReserved + artifact.sizeBytes > monthlyLimitBytes) {
            return {
                recordingId: recording.id,
                artifactPath: artifact.path,
                sizeBytes: artifact.sizeBytes,
                disposition: "blocked" as const,
                reason: "monthly_upload_limit",
            };
        }
        simulatedReserved += artifact.sizeBytes;
        return {
            recordingId: recording.id,
            artifactPath: artifact.path,
            sizeBytes: artifact.sizeBytes,
            disposition: "would_upload" as const,
            reason: null,
        };
    });
}
