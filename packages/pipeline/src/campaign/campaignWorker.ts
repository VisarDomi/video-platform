import path from "node:path";

import type { PipelineConfig } from "../config.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { Recording } from "../domain/types.js";
import { TargetCatalogResolver } from "../provenance/targetResolver.js";
import { PipelineOrchestrator } from "../scheduler/orchestrator.js";
import { createDefaultStages } from "../stages/defaultStages.js";
import { captureKeyFromFolderName, selectOldestFinalizedEditedCandidate } from "./selectCandidate.js";
import { REQUEST_OVERHEAD_RESERVATION_BYTES } from "../commands/uploadOne.js";
import { verifyCurrentServerAuthority } from "../discovery/verifyCurrentAuthority.js";

export type CampaignStepResult =
    | { readonly disposition: "paused" | "idle"; readonly reviewRequired: number }
    | { readonly disposition: "admitted" | "stage_completed"; readonly recordingId: string; readonly state: string }
    | { readonly disposition: "awaiting_upload_activation"; readonly recordingId: string }
    | { readonly disposition: "attention_required"; readonly recordingId: string; readonly reason: string }
    | { readonly disposition: "monthly_quota_wait"; readonly recordingId: string }
    | { readonly disposition: "upload_completed"; readonly recordingId: string; readonly result: unknown };

function ordered(recordings: readonly Recording[], providerFilter: string): Recording[] {
    return recordings.filter((recording) => recording.sourceKind === "edited"
        && (providerFilter === "all" || recording.provider === providerFilter)
        && captureKeyFromFolderName(path.basename(recording.sourcePath)) !== null)
        .sort((left, right) => {
            const leftKey = captureKeyFromFolderName(path.basename(left.sourcePath)) ?? "";
            const rightKey = captureKeyFromFolderName(path.basename(right.sourcePath)) ?? "";
            return leftKey.localeCompare(rightKey) || left.provider.localeCompare(right.provider)
                || left.sourcePath.localeCompare(right.sourcePath);
        });
}

export class CampaignWorker {
    private readonly orchestrator: PipelineOrchestrator;

    constructor(
        private readonly database: PipelineDatabase,
        private readonly config: PipelineConfig,
        private readonly resolver: TargetCatalogResolver,
        private readonly upload?: (recordingId: string, monthlyLimitBytes: number) => Promise<unknown>,
        workerId = `pipeline-campaign-${process.pid}`,
    ) {
        this.orchestrator = new PipelineOrchestrator(
            database,
            createDefaultStages(config.stagingRoot),
            workerId,
        );
    }

    async step(now = new Date()): Promise<CampaignStepResult> {
        const control = this.database.getCampaignControl();
        const reviewRequired = this.database.listProvenanceReview().length;
        if (control.state === "paused") return { disposition: "paused", reviewRequired };

        const local = ordered(this.database.list().filter((recording) => [
            "server_ready", "remuxed", "artifact_valid", "described",
        ].includes(recording.state)), control.providerFilter);
        if (local[0]) {
            try {
                await verifyCurrentServerAuthority(local[0], this.config);
            } catch (error) {
                return {
                    disposition: "attention_required",
                    recordingId: local[0].id,
                    reason: error instanceof Error ? error.message : String(error),
                };
            }
            const result = await this.orchestrator.processRecording(local[0].id, now);
            if (!result) throw new Error(`Could not claim campaign recording ${local[0].id}`);
            return { disposition: "stage_completed", recordingId: result.id, state: result.state };
        }

        const uploadReady = ordered(this.database.list("metadata_ready"), control.providerFilter)[0];
        if (uploadReady) {
            try {
                await verifyCurrentServerAuthority(uploadReady, this.config);
            } catch (error) {
                return {
                    disposition: "attention_required",
                    recordingId: uploadReady.id,
                    reason: error instanceof Error ? error.message : String(error),
                };
            }
            const provenance = this.database.getProvenance(uploadReady.id);
            if (!provenance?.streamerId) {
                return {
                    disposition: "attention_required",
                    recordingId: uploadReady.id,
                    reason: "streamer_unresolved",
                };
            }
            const artifact = this.database.getArtifact(uploadReady.id);
            if (!artifact) {
                return { disposition: "attention_required", recordingId: uploadReady.id, reason: "artifact_missing" };
            }
            if (!this.database.canReserve(
                artifact.sizeBytes + REQUEST_OVERHEAD_RESERVATION_BYTES,
                now,
                this.config.uploadTimeZone,
                control.monthlyUploadLimitBytes,
            )) return { disposition: "monthly_quota_wait", recordingId: uploadReady.id };
            if (!this.upload) return { disposition: "awaiting_upload_activation", recordingId: uploadReady.id };
            return {
                disposition: "upload_completed",
                recordingId: uploadReady.id,
                result: await this.upload(uploadReady.id, control.monthlyUploadLimitBytes),
            };
        }

        const candidate = await selectOldestFinalizedEditedCandidate({
            finalizationDatabasePath: this.config.finalizationDatabasePath,
            roots: this.config.discoveryRoots,
            providerFilter: control.providerFilter,
            pipelineDatabase: this.database,
        });
        if (!candidate) return { disposition: "idle", reviewRequired };
        const recording = this.database.discover(candidate, now);
        const resolution = await this.resolver.resolve(candidate, now);
        this.database.saveProvenance(recording.id,
            this.database.getProvenanceOverride(candidate.provider, resolution.observedIdentifier) ?? resolution);
        return { disposition: "admitted", recordingId: recording.id, state: recording.state };
    }
}
