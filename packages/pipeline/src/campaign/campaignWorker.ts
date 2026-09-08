import path from "node:path";
import { unlink } from "node:fs/promises";

import type { PipelineConfig } from "../config.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { Recording, RecordingInput } from "../domain/types.js";
import { TargetCatalogResolver } from "../provenance/targetResolver.js";
import { PipelineOrchestrator } from "../scheduler/orchestrator.js";
import { createDefaultStages } from "../stages/defaultStages.js";
import { captureKeyFromFolderName, selectOldestFinalizedEditedCandidate } from "./selectCandidate.js";
import { sweepMissingRecordings } from "../commands/sweep.js";
import { REQUEST_OVERHEAD_RESERVATION_BYTES } from "../commands/uploadOne.js";
import { verifyCurrentServerAuthority } from "../discovery/verifyCurrentAuthority.js";
import { HumanActionRequiredError, type ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";
import {
    analyzeRecordingResolution,
    chooseRecordingResolutionPolicy,
    RESOLUTION_POLICY_VERSION,
    resolutionPolicyReason,
} from "../stages/resolutionPolicy.js";

export type CampaignStepResult =
    | { readonly disposition: "paused" | "idle"; readonly reviewRequired: number }
    | { readonly disposition: "trial_finished"; readonly reviewRequired: number; readonly trial: ReturnType<PipelineDatabase["getCampaignTrialProgress"]> }
    | { readonly disposition: "trial_verification_wait" | "trial_attention_required"; readonly reviewRequired: number; readonly trial: ReturnType<PipelineDatabase["getCampaignTrialProgress"]> }
    | { readonly disposition: "admitted" | "stage_completed"; readonly recordingId: string; readonly state: string }
    | { readonly disposition: "awaiting_upload_activation"; readonly recordingId: string }
    | { readonly disposition: "attention_required"; readonly recordingId: string; readonly reason: string }
    | { readonly disposition: "monthly_quota_wait"; readonly recordingId: string }
    | { readonly disposition: "parked_existing_upload"; readonly recordingId: string; readonly state: string }
    | { readonly disposition: "antibot_cooldown"; readonly recordingId: string; readonly streak: number; readonly resumeAt: string }
    | { readonly disposition: "daily_limit_cooldown"; readonly recordingId: string; readonly resumeAt: string }
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
        _uploader?: ChromiumXvideosUploader,
        workerId = `pipeline-campaign-${process.pid}`,
    ) {
        this.orchestrator = new PipelineOrchestrator(
            database,
            createDefaultStages(config.stagingRoot),
            workerId,
        );
    }

    private async enforceCurrentResolutionPolicy(
        recording: Recording,
        now: Date,
    ): Promise<CampaignStepResult | null> {
        if (recording.state === "server_ready"
            || this.database.hasResolutionPolicyAssessment(recording.id, RESOLUTION_POLICY_VERSION)) {
            return null;
        }
        const analysis = await analyzeRecordingResolution(recording.playlistPath);
        const policy = chooseRecordingResolutionPolicy(analysis);
        const reason = resolutionPolicyReason(policy.reason);
        if (policy.disposition === "remux1080") {
            this.database.recordResolutionPolicyAssessment(recording.id, reason, now);
            return null;
        }
        const reset = this.database.resetLocalWorkForResolutionPolicy(recording.id, reason, now);
        await Promise.all(reset.obsoletePaths.map((obsoletePath) => unlink(obsoletePath).catch(() => undefined)));
        return {
            disposition: "stage_completed",
            recordingId: recording.id,
            state: reset.recording.state,
        };
    }

    private async admit(candidate: RecordingInput, now: Date): Promise<CampaignStepResult> {
        const recording = this.database.discover(candidate, now);
        this.database.enrollCampaignTrial(recording, now);
        const resolution = await this.resolver.resolve(candidate, now);
        this.database.saveProvenance(recording.id,
            this.database.getProvenanceOverride(candidate.provider, resolution.observedIdentifier) ?? resolution);
        return { disposition: "admitted", recordingId: recording.id, state: recording.state };
    }

    async step(now = new Date()): Promise<CampaignStepResult> {
        // Disk is the truth: forget recordings whose source folder is gone.
        const swept = await sweepMissingRecordings(this.database, this.config, now);
        if (swept.length > 0) {
            console.log(JSON.stringify({ event: "campaign-sweep", swept }));
        }
        let control = this.database.getCampaignControl();
        const reviewRequired = this.database.listProvenanceReview().length
            + this.database.list("blocked").length;
        if (control.state === "paused") {
            if (control.resumeAt && now.getTime() >= Date.parse(control.resumeAt)) {
                control = this.database.resumeFromCooldown(now);
            } else {
                return { disposition: "paused", reviewRequired };
            }
        }

        const selectCandidate = () => selectOldestFinalizedEditedCandidate({
            finalizationDatabasePath: this.config.finalizationDatabasePath,
            roots: this.config.discoveryRoots,
            providerFilter: control.providerFilter,
            pipelineDatabase: this.database,
            allowedProviders: ["tango", "fc2", "sc"].filter((provider) => this.database.campaignTrialAllows(provider)),
        });
        let trialNextId: string | undefined;
        if (control.trialPerProvider !== null) {
            const pending = ordered(this.database.list().filter((recording) => [
                "server_ready", "remuxed", "artifact_valid", "described", "metadata_ready",
            ].includes(recording.state) && this.database.campaignTrialAllows(recording.provider, recording.id)), control.providerFilter);
            const first = pending[0];
            const enrolled = new Set(this.database.getCampaignTrialProgress().flatMap((item) => item.recordings.map((recording) => recording.id)));
            // Already queued local work must not take a slot ahead of an older,
            // not-yet-discovered source. Once admitted, finish its stages first.
            if (first && !enrolled.has(first.id)) {
                const candidate = await selectCandidate();
                const key = (recording: RecordingInput) => `${captureKeyFromFolderName(path.basename(recording.sourcePath))}|${recording.provider}|${recording.sourcePath}`;
                if (candidate && key(candidate).localeCompare(key(first)) < 0) return this.admit(candidate, now);
            }
            trialNextId = first?.id;
        }
        const local = ordered(this.database.list().filter((recording) => [
            "server_ready", "remuxed", "artifact_valid", "described",
        ].includes(recording.state) && (!trialNextId || recording.id === trialNextId)
            && this.database.campaignTrialAllows(recording.provider, recording.id)), control.providerFilter);
        if (local[0]) {
            this.database.enrollCampaignTrial(local[0], now);
            try {
                await verifyCurrentServerAuthority(local[0], this.config);
                const resolutionResult = await this.enforceCurrentResolutionPolicy(local[0], now);
                if (resolutionResult) return resolutionResult;
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

        const uploadReady = ordered(this.database.list("metadata_ready")
            .filter((recording) => (!trialNextId || recording.id === trialNextId)
                && this.database.campaignTrialAllows(recording.provider, recording.id)), control.providerFilter)[0];
        if (uploadReady) {
            this.database.enrollCampaignTrial(uploadReady, now);
            try {
                await verifyCurrentServerAuthority(uploadReady, this.config);
                const resolutionResult = await this.enforceCurrentResolutionPolicy(uploadReady, now);
                if (resolutionResult) return resolutionResult;
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
            try {
                const result = await this.upload(uploadReady.id, control.monthlyUploadLimitBytes);
                this.database.resetAntibotFailures(now);
                return {
                    disposition: "upload_completed",
                    recordingId: uploadReady.id,
                    result,
                };
            } catch (error) {
                if (error instanceof HumanActionRequiredError && error.action === "daily_limit") {
                    const after = this.database.recordUploadLimitCooldown(now);
                    return {
                        disposition: "daily_limit_cooldown",
                        recordingId: uploadReady.id,
                        resumeAt: after.resumeAt ?? "",
                    };
                }
                if (error instanceof HumanActionRequiredError) {
                    const streak = control.antibotFailures + 1;
                    const exponent = Math.min(streak - 1, 40);
                    const waitMilliseconds = 60_000 * (2 ** exponent);
                    const after = this.database.recordAntibotFailure(streak, waitMilliseconds, now);
                    return {
                        disposition: "antibot_cooldown",
                        recordingId: uploadReady.id,
                        streak,
                        resumeAt: after.resumeAt ?? "",
                    };
                }
                throw error;
            }
        }

        const candidate = await selectCandidate();
        if (!candidate) {
            if (control.trialPerProvider !== null) {
                const trial = this.database.getCampaignTrialProgress();
                const pending = trial.flatMap((provider) => provider.recordings);
                if (pending.some((recording) => ["xvideos_admitted", "xvideos_uploading", "xvideos_uploaded", "xvideos_uncertain"].includes(recording.state))) {
                    // Verification runs inline even without new campaign work.
                    // Confirmed absence can return the same slot to metadata_ready
                    // for retry; never substitute an extra recording for it.
                    return { disposition: "trial_verification_wait", reviewRequired, trial };
                }
                if (trial.some((provider) => provider.admitted < control.trialPerProvider!)
                    || pending.some((recording) => !["xvideos_verified", "cleanup_eligible"].includes(recording.state))) {
                    // Do not clear the trial on a later manual resume: failed
                    // slots still belong to this unfinished bounded run.
                    this.database.setCampaignState("paused", now);
                    return { disposition: "trial_attention_required", reviewRequired, trial };
                }
                this.database.finishCampaignTrial(now);
                return { disposition: "trial_finished", reviewRequired, trial };
            }
            return { disposition: "idle", reviewRequired };
        }
        // Check the current-generation remote identity immediately before upload.
        return this.admit(candidate, now);
    }
}
