import path from "node:path";
import { access, statfs, unlink } from "node:fs/promises";
import type { AccountSlot } from "./accountSlot.js";

import { sourcesOf, type PipelineConfig } from "../config.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { CampaignControl, Recording, RecordingInput } from "../domain/types.js";
import { TargetCatalogResolver } from "../provenance/targetResolver.js";
import { allowsUpload } from "../provenance/uploadPolicy.js";
import { PipelineOrchestrator, StageDeferredError } from "../scheduler/orchestrator.js";
import { createDefaultStages } from "../stages/defaultStages.js";
import { captureKeyFromFolderName, selectOldestFinalizedEditedCandidate } from "./selectCandidate.js";
import { sweepMissingRecordings } from "../commands/sweep.js";
import { REQUEST_OVERHEAD_RESERVATION_BYTES } from "../commands/uploadOne.js";
import { verifyCurrentServerAuthority } from "../discovery/verifyCurrentAuthority.js";
import { HumanActionRequiredError } from "../upload/browserUpload.js";
import { MetadataRejectedError, ProviderSessionLostError } from "../upload/providerWarnings.js";
import { RESOLUTION_POLICY_VERSION, resolutionPolicyReason } from "../stages/resolutionPolicy.js";
import { cancelInvalidShortBatch, maintainAutomaticShorts } from "./shorts.js";

// First wait after an upload failed before sending anything (a page timeout).
const PRE_TRANSFER_RETRY_MILLISECONDS = 15 * 60_000;

export type CampaignStepResult =
    | { readonly disposition: "shorts_waiting" | "shorts_joined"; readonly registered: number; readonly joined: readonly string[] }
    | { readonly disposition: "comparison_finished" | "comparison_verification_wait" | "comparison_attention_required"; readonly reason?: string }
    | { readonly disposition: "paused" | "idle"; readonly reviewRequired: number; readonly uploads?: string }
    | ({ readonly disposition: "full_ahead"; readonly reviewRequired: number; readonly uploads: string } & AheadRoom)
    | { readonly disposition: "trial_finished"; readonly reviewRequired: number; readonly trial: ReturnType<PipelineDatabase["getCampaignTrialProgress"]> }
    | { readonly disposition: "trial_verification_wait" | "trial_attention_required"; readonly reviewRequired: number; readonly trial: ReturnType<PipelineDatabase["getCampaignTrialProgress"]> }
    | { readonly disposition: "admitted" | "stage_completed"; readonly recordingId: string; readonly state: string }
    | { readonly disposition: "awaiting_upload_activation"; readonly recordingId: string }
    | { readonly disposition: "attention_required"; readonly recordingId: string; readonly reason: string }
    | { readonly disposition: "upload_quota_wait"; readonly recordingId: string; readonly budget: ReturnType<PipelineDatabase["uploadBudget"]> }
    | { readonly disposition: "resource_wait"; readonly recordingId: string; readonly reason: string }
    | { readonly disposition: "parked_existing_upload"; readonly recordingId: string; readonly state: string }
    | { readonly disposition: "antibot_cooldown"; readonly recordingId: string; readonly streak: number; readonly resumeAt: string }
    | { readonly disposition: "daily_limit_cooldown"; readonly recordingId: string; readonly resumeAt: string }
    | { readonly disposition: "upload_retry_cooldown"; readonly recordingId: string; readonly resumeAt: string; readonly reason: string }
    | { readonly disposition: "metadata_rejected"; readonly recordingId: string; readonly rejectedPhrases: readonly string[] }
    | { readonly disposition: "upload_completed"; readonly recordingId: string; readonly result: unknown };

export interface AheadRoom {
    readonly readyBytes: number;
    readonly limitBytes: number;
    readonly freeBytes: number;
    readonly floorBytes: number;
    readonly admits: boolean;
}

// The worker's three lanes, each on its own resource and its own recording at a time:
// conversion (the CPU), description (the GPU), upload (the network). Each takes the oldest
// recording waiting for it, so one recording follows the next through the three.
export type CampaignLane = "convert" | "describe" | "upload";
const LANE_STATES: Readonly<Record<Exclude<CampaignLane, "upload">, readonly string[]>> = {
    convert: ["server_ready", "remuxed"],
    describe: ["artifact_valid", "described"],
};
const LOCAL_STATES = ["server_ready", "remuxed", "artifact_valid", "described"];

export interface CampaignWorkerOptions {
    // The account slot the worker's lanes share (none: this process is the only uploader).
    readonly slot?: AccountSlot;
    // Uploads are held for a reason outside the campaign row (the daily verification failed).
    readonly uploadHold?: string | null;
    // The lane this step belongs to (none: one step of whichever stage is due, in turn).
    readonly lane?: CampaignLane;
}

// Campaign order: edited recordings of the filter's sites, oldest capture first.
export function ordered(recordings: readonly Recording[], providerFilter: string): Recording[] {
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
        private readonly upload?: (recordingId: string) => Promise<unknown>,
        workerId = `pipeline-campaign-${process.pid}`,
        private readonly options: CampaignWorkerOptions = {},
    ) {
        this.orchestrator = new PipelineOrchestrator(
            database,
            createDefaultStages(config.stagingRoot, config),
            options.lane ? `${workerId}-${options.lane}` : workerId,
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
        // Local work from an older policy (unrotated, or with dropped segments)
        // is never uploaded: convert the recording again under the current one.
        const reason = resolutionPolicyReason("local work predates this policy; converting again");
        if (this.database.getComparisonTrial()) throw new Error("Comparison artifact policy changed; retain evidence and prepare a new version instead of deleting it");
        const reset = this.database.resetLocalWorkForResolutionPolicy(recording.id, reason, now);
        await Promise.all(reset.obsoletePaths.map((obsoletePath) => unlink(obsoletePath).catch(() => undefined)));
        return {
            disposition: "stage_completed",
            recordingId: recording.id,
            state: reset.recording.state,
        };
    }

    private async admit(candidate: RecordingInput, now: Date): Promise<CampaignStepResult> {
        if (this.database.getComparisonTrial() && !this.database.comparisonAllows(candidate)) {
            return { disposition: "idle", reviewRequired: 0 };
        }
        // Resolved first: a resolution that fails (a server older than this pipeline)
        // leaves nothing half-admitted, and a later step admits the recording.
        const resolution = await this.resolver.resolve(candidate, now);
        const recording = this.database.discover(candidate, now);
        this.database.enrollCampaignTrial(recording, now);
        this.database.saveProvenance(recording.id,
            this.database.getProvenanceOverride(candidate.provider, resolution.observedIdentifier) ?? resolution);
        return { disposition: "admitted", recordingId: recording.id, state: recording.state };
    }

    // Recordings already in the ledger without a provenance row (for example, re-queued
    // after a retired upload destination) bypass admit(); resolve them before local stages
    // so described recordings do not stall in provenance_review_required.
    private async ensureProvenance(recording: Recording, now: Date): Promise<void> {
        if (this.database.getProvenance(recording.id)) return;
        const resolution = await this.resolver.resolve(recording, now);
        this.database.saveProvenance(
            recording.id,
            this.database.getProvenanceOverride(recording.provider, resolution.observedIdentifier) ?? resolution,
        );
    }

    // One named recording through the worker's own local stages (the server's authority, the
    // current resolution policy, provenance, conversion, validation, description) until it
    // leaves them: ready to upload, or held for a reason the ledger records. Uploads nothing.
    async prepare(recordingId: string, now = () => new Date()): Promise<CampaignStepResult> {
        const local = ["server_ready", "remuxed", "artifact_valid", "described"];
        for (;;) {
            const recording = this.database.get(recordingId);
            if (!recording) throw new Error(`Unknown pipeline recording ${recordingId}`);
            if (recording.sourceKind !== "edited") throw new Error(`Recording ${recordingId} is not an edited recording`);
            if (!local.includes(recording.state)) {
                return { disposition: "stage_completed", recordingId, state: recording.state };
            }
            await verifyCurrentServerAuthority(recording, this.config, this.database);
            if (await this.enforceCurrentResolutionPolicy(recording, now())) continue;
            await this.ensureProvenance(recording, now());
            try {
                const result = await this.orchestrator.processRecording(recordingId, now());
                if (!result) throw new Error(`Could not claim recording ${recordingId} (another worker holds it)`);
                console.error(JSON.stringify({ event: "prepare-stage", recordingId, state: result.state }));
            } catch (error) {
                if (!(error instanceof StageDeferredError)) throw error;
                return { disposition: "resource_wait", recordingId, reason: error.message };
            }
        }
    }

    // One prepared recording's upload: the last checks, the allowance, the upload and what
    // its outcome means for the campaign.
    private async uploadPrepared(uploadReady: Recording, control: CampaignControl, comparison: unknown, now: Date): Promise<CampaignStepResult> {
        this.database.enrollCampaignTrial(uploadReady, now);
        try {
            await verifyCurrentServerAuthority(uploadReady, this.config, this.database);
            const resolutionResult = await this.enforceCurrentResolutionPolicy(uploadReady, now);
            if (resolutionResult) return resolutionResult;
        } catch (error) {
            if (await cancelInvalidShortBatch(this.database, this.config, uploadReady.id, String(error), now)) {
                return { disposition: "stage_completed", recordingId: uploadReady.id, state: "short_cancelled" };
            }
            if (comparison) this.database.setCampaignState("paused", now);
            return {
                disposition: "attention_required",
                recordingId: uploadReady.id,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
        const provenance = this.database.getProvenance(uploadReady.id);
        if (!allowsUpload(provenance)) {
            if (comparison) this.database.setCampaignState("paused", now);
            return {
                disposition: "attention_required",
                recordingId: uploadReady.id,
                reason: "streamer_unresolved",
            };
        }
        const artifact = this.database.getArtifact(uploadReady.id);
        if (!artifact) {
            if (comparison) this.database.setCampaignState("paused", now);
            return { disposition: "attention_required", recordingId: uploadReady.id, reason: "artifact_missing" };
        }
        if (!this.database.canReserve(
            artifact.sizeBytes + REQUEST_OVERHEAD_RESERVATION_BYTES,
            now,
            this.config.uploadTimeZone,
            control.dailyUploadLimitBytes,
        )) return { disposition: "upload_quota_wait", recordingId: uploadReady.id,
            budget: this.database.uploadBudget(now, this.config.uploadTimeZone, control.dailyUploadLimitBytes) };
        if (!this.upload) return { disposition: "awaiting_upload_activation", recordingId: uploadReady.id };
        try {
            const result = await this.upload(uploadReady.id);
            const afterUpload = this.database.get(uploadReady.id);
            if (afterUpload?.state === "short_waiting" || afterUpload?.state === "artifact_valid"
                && this.database.shortParts(uploadReady.id).some(part => !part.verified)) {
                return { disposition: "stage_completed", recordingId: uploadReady.id, state: afterUpload.state };
            }
            if (afterUpload?.state === "blocked") return {
                disposition: "attention_required", recordingId: uploadReady.id,
                reason: afterUpload.blockReason ?? "Upload provider policy requires manual review",
            };
            // Rejected phrases found locally: nothing was sent, describe again.
            if (afterUpload?.state === "artifact_valid") {
                return { disposition: "stage_completed", recordingId: uploadReady.id, state: afterUpload.state };
            }
            this.database.resetAntibotFailures(now);
            return {
                disposition: "upload_completed",
                recordingId: uploadReady.id,
                result,
            };
        } catch (error) {
            if (error instanceof ProviderSessionLostError) {
                // Logging in again would log the phone out: stop and say why.
                // A user may have paused while the upload was in flight.
                // Keep that manual hold instead of making it auto-recoverable.
                if (this.database.getCampaignControl().state === "running") this.database.pauseForAttention(error.message, now);
                this.database.recordProviderSessionEvent({ provider: this.config.uploadProvider ?? this.database.getActiveUploadProvider(),
                    kind: "lost", loggedIn: false, note: error.message }, now);
                return { disposition: "attention_required", recordingId: uploadReady.id, reason: error.message };
            }
            if (error instanceof MetadataRejectedError) {
                // Definitive and already learned; the recording is back for
                // re-description. Not an anti-bot event, no cooldown.
                return { disposition: "metadata_rejected", recordingId: uploadReady.id, rejectedPhrases: [...error.phrases] };
            }
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
                const waitMilliseconds = error.action === "session_login" ? 24 * 60 * 60_000
                    : Math.min(24 * 60 * 60_000, 60_000 * (2 ** exponent));
                const after = this.database.recordAntibotFailure(streak, waitMilliseconds, now);
                return {
                    disposition: "antibot_cooldown",
                    recordingId: uploadReady.id,
                    streak,
                    resumeAt: after.resumeAt ?? "",
                };
            }
            // Transport/login timeouts can arrive as ordinary Playwright
            // errors. A failed pre-transfer attempt sent nothing and created
            // no video, so it is retried soon, waiting twice as long after
            // each failure in a row (the streak a successful upload resets);
            // an uncertain transfer is reconciled separately, never repeated.
            const afterFailure = this.database.get(uploadReady.id);
            if (afterFailure?.state === "metadata_ready") {
                const streak = control.antibotFailures + 1;
                const waitMilliseconds = Math.min(24 * 60 * 60_000,
                    PRE_TRANSFER_RETRY_MILLISECONDS * (2 ** Math.min(streak - 1, 40)));
                const after = this.database.recordAntibotFailure(streak, waitMilliseconds, now);
                return { disposition: "upload_retry_cooldown", recordingId: uploadReady.id,
                    resumeAt: after.resumeAt ?? "", reason: error instanceof Error ? error.message : String(error) };
            }
            if (afterFailure?.state === "upload_uncertain") {
                return { disposition: "upload_completed", recordingId: uploadReady.id,
                    result: { state: "upload_uncertain", reason: "Awaiting acceptance reconciliation; no re-upload" } };
            }
            if (comparison) this.database.setCampaignState("paused", now);
            throw error;
        }
    }

    // How far conversion is ahead of uploads: the ready files' bytes against the cap (one
    // carrier's worth plus two days of home's allowance), and the free space on the
    // artifacts filesystem against the uplink's floor.
    async aheadRoom(control: CampaignControl = this.database.getCampaignControl()): Promise<AheadRoom> {
        const uplink = this.config.uplink!;
        const readyBytes = this.database.readyArtifactBytes();
        const limitBytes = uplink.carrier.capacityBytes + 2 * control.dailyUploadLimitBytes;
        const space = await statfs(this.config.stagingRoot).catch(() => statfs(this.config.artifactsRoot));
        const freeBytes = space.bavail * space.bsize;
        return { readyBytes, limitBytes, freeBytes, floorBytes: uplink.minFreeBytes,
            admits: readyBytes < limitBytes && freeBytes > uplink.minFreeBytes };
    }

    // A home upload when one can go (no hold, the account slot free, home's allowance): its
    // outcome, or why none went. Files on a carrier belong to the other uplink.
    private async uploadAhead(control: CampaignControl, hold: string | null, now: Date): Promise<CampaignStepResult | string> {
        if (hold) return `held: ${hold}`;
        if (!this.upload) return "network uploads off";
        const uploadReady = this.order(control, this.database.list("metadata_ready").filter((recording) =>
            this.database.canAttemptUpload(recording.id, now) && !this.database.carrierCopy(recording.id)))[0];
        if (!uploadReady) return "nothing ready";
        const artifact = this.database.getArtifact(uploadReady.id);
        if (artifact && !this.database.canReserve(artifact.sizeBytes + REQUEST_OVERHEAD_RESERVATION_BYTES,
            now, this.config.uploadTimeZone, control.dailyUploadLimitBytes)) return "waiting for home's allowance";
        const release = this.options.slot ? this.options.slot.tryTake("home-upload") : () => undefined;
        if (!release) return `account busy (${this.options.slot?.heldBy})`;
        try {
            const result = await this.uploadPrepared(uploadReady, control, null, now);
            if (result.disposition === "upload_quota_wait") return "waiting for home's allowance";
            if (result.disposition === "awaiting_upload_activation") return "network uploads off";
            return result;
        } finally { release(); }
    }

    private order(control: CampaignControl, recordings: readonly Recording[]): Recording[] {
        return ordered(recordings.filter((recording) => this.database.campaignTrialAllows(recording.provider, recording.id)
            && !this.database.localSourceIsAbsent(recording.id)), control.providerFilter);
    }

    // The oldest local stage among these states, or (admitting) a new recording that is older
    // still, while the cap and the disk allow one. Null when there is neither.
    private async localAhead(control: CampaignControl, states: readonly string[], admitting: boolean, room: AheadRoom | null,
        now: Date): Promise<CampaignStepResult | null> {
        const key = (recording: RecordingInput) => `${captureKeyFromFolderName(path.basename(recording.sourcePath))}|${recording.provider}|${recording.sourcePath}`;
        const local = this.order(control, this.database.list().filter((recording) => states.includes(recording.state)));
        const candidate = admitting && room?.admits ? await selectOldestFinalizedEditedCandidate({
            finalizationDatabasePath: this.config.finalizationDatabasePath,
            roots: this.config.discoveryRoots,
            providerFilter: control.providerFilter,
            pipelineDatabase: this.database,
            allowedProviders: sourcesOf(this.config).filter((provider) => this.database.campaignTrialAllows(provider)),
        }) : null;
        // An older source goes before newer local work (joined shorts batches never jump ahead).
        if (candidate && (!local[0] || key(candidate).localeCompare(key(local[0])) < 0)) return this.admit(candidate, now);
        const recording = local[0];
        if (!recording) return null;
        try {
            await verifyCurrentServerAuthority(recording, this.config, this.database);
            const resolutionResult = await this.enforceCurrentResolutionPolicy(recording, now);
            if (resolutionResult) return resolutionResult;
        } catch (error) {
            if (await cancelInvalidShortBatch(this.database, this.config, recording.id, String(error), now)) {
                return { disposition: "stage_completed", recordingId: recording.id, state: "short_cancelled" };
            }
            return { disposition: "attention_required", recordingId: recording.id, reason: error instanceof Error ? error.message : String(error) };
        }
        try {
            await this.ensureProvenance(recording, now);
            const result = await this.orchestrator.processRecording(recording.id, now);
            if (!result) throw new Error(`Could not claim campaign recording ${recording.id}`);
            return { disposition: "stage_completed", recordingId: result.id, state: result.state };
        } catch (error) {
            if (!(error instanceof StageDeferredError)) throw error;
            return { disposition: "resource_wait", recordingId: recording.id, reason: error.message };
        }
    }

    private async maintainShorts(now: Date): Promise<CampaignStepResult | null> {
        if (!this.config.automaticShortsEnabled) return null;
        const shorts = await maintainAutomaticShorts(this.database, this.config, this.resolver, now);
        return shorts.joined.length || shorts.registered
            ? { disposition: shorts.joined.length ? "shorts_joined" : "shorts_waiting", ...shorts } : null;
    }

    // One step when conversion runs ahead. In a lane: that lane's own stage. Without one (a
    // manual campaign-step): a home upload when one can go, else the oldest local stage, else
    // a new recording while the cap and the disk allow.
    private async stepAhead(control: CampaignControl, reviewRequired: number, hold: string | null, now: Date): Promise<CampaignStepResult> {
        const lane = this.options.lane;
        if (lane === "upload") {
            const uploaded = await this.uploadAhead(control, hold, now);
            return typeof uploaded === "string" ? { disposition: "idle", reviewRequired, uploads: uploaded } : uploaded;
        }
        if (lane === "describe") {
            return await this.localAhead(control, LANE_STATES.describe, false, null, now) ?? { disposition: "idle", reviewRequired };
        }
        const shorts = await this.maintainShorts(now);
        if (shorts) return shorts;
        let uploads = "in the upload lane";
        if (!lane) {
            const uploaded = await this.uploadAhead(control, hold, now);
            if (typeof uploaded !== "string") return uploaded;
            uploads = uploaded;
        }
        const room = await this.aheadRoom(control);
        const local = await this.localAhead(control, lane === "convert" ? LANE_STATES.convert : LOCAL_STATES, true, room, now);
        if (local) return local;
        if (!room.admits) return { disposition: "full_ahead", reviewRequired, uploads, ...room };
        return { disposition: "idle", reviewRequired, uploads };
    }

    async step(now = new Date()): Promise<CampaignStepResult> {
        // Track local availability separately; never erase remote history (one lane does it).
        if (!this.options.lane || this.options.lane === "convert") {
            const swept = await sweepMissingRecordings(this.database, this.config, now);
            if (swept.length > 0) console.log(JSON.stringify({ event: "campaign-sweep", swept }));
        }
        let control = this.database.getCampaignControl();
        const comparison = this.database.getComparisonTrial();
        const reviewRequired = this.database.listProvenanceReview().length
            + this.database.list("blocked").length;
        // With a second uplink (and no trial or comparison run), conversion never waits for
        // uploads: a cooldown or an attention hold holds uploads only.
        const ahead = Boolean(this.config.uplink) && !comparison && !this.config.comparisonTrialOnly && control.trialPerProvider === null;
        if (control.state === "paused") {
            if (control.resumeAt && now.getTime() >= Date.parse(control.resumeAt)) {
                control = this.database.resumeFromCooldown(now);
            } else if (!ahead || (control.resumeAt === null && control.attentionReason === null)) {
                return { disposition: "paused", reviewRequired };
            }
        }
        if (ahead) {
            const hold = control.state === "paused"
                ? control.attentionReason ?? `cooldown until ${control.resumeAt}` : this.options.uploadHold ?? null;
            return await this.stepAhead(control, reviewRequired, hold, now);
        }
        // A trial or a comparison runs one stage at a time, in the upload lane alone.
        if (this.options.lane && this.options.lane !== "upload") return { disposition: "idle", reviewRequired };

        if (this.config.comparisonTrialOnly && !comparison) {
            this.database.setCampaignState("paused", now);
            return { disposition: "comparison_attention_required", reason: "Prepare and select the comparison trial first" };
        }
        if (comparison && (comparison.selection.length === 0 || comparison.completedAt)) {
            return { disposition: "comparison_finished", reason: "Waiting for additions to the selected queue; no library discovery" };
        }
        if (comparison && comparison.selection.some((source) => {
            const recording = this.database.getBySourcePath(source.sourcePath);
            return recording && ["failed", "blocked", "provenance_review_required"].includes(recording.state);
        })) {
            this.database.setCampaignState("paused", now);
            return { disposition: "comparison_attention_required", reason: "A selected recording failed or requires review" };
        }
        const allows = (recording: Recording) => comparison ? this.database.comparisonAllows(recording)
            : this.database.campaignTrialAllows(recording.provider, recording.id);
        if (this.config.automaticShortsEnabled && !comparison && control.trialPerProvider === null) {
            const shorts = await maintainAutomaticShorts(this.database, this.config, this.resolver, now);
            if (shorts.joined.length || shorts.registered) return {
                disposition: shorts.joined.length ? "shorts_joined" : "shorts_waiting", ...shorts,
            };
        }
        const order = (recordings: readonly Recording[], provider: string) => {
            const candidates = ordered(recordings.filter(recording => !this.database.localSourceIsAbsent(recording.id)), provider);
            return comparison ? candidates.filter(allows).sort((a, b) =>
                comparison.selection.findIndex((r) => r.sourcePath === a.sourcePath)
                - comparison.selection.findIndex((r) => r.sourcePath === b.sourcePath)) : candidates;
        };
        const selectCandidate = async () => comparison
            ? comparison.selection.find((source) => !this.database.getBySourcePath(source.sourcePath)) ?? null
            : selectOldestFinalizedEditedCandidate({
            finalizationDatabasePath: this.config.finalizationDatabasePath,
            roots: this.config.discoveryRoots,
            providerFilter: control.providerFilter,
            pipelineDatabase: this.database,
            allowedProviders: sourcesOf(this.config).filter((provider) => this.database.campaignTrialAllows(provider)),
        });
        let trialNextId: string | undefined;
        if (control.trialPerProvider !== null) {
            const pending = ordered(this.database.list().filter((recording) => [
                "server_ready", "remuxed", "artifact_valid", "described", "metadata_ready",
            ].includes(recording.state) && this.database.campaignTrialAllows(recording.provider, recording.id)), control.providerFilter);
            const first = pending[0];
            const enrolled = new Set(this.database.getCampaignTrialProgress(sourcesOf(this.config)).flatMap((item) => item.recordings.map((recording) => recording.id)));
            // Already queued local work must not take a slot ahead of an older,
            // not-yet-discovered source. Once admitted, finish its stages first.
            if (first && !enrolled.has(first.id)) {
                const candidate = await selectCandidate();
                const key = (recording: RecordingInput) => `${captureKeyFromFolderName(path.basename(recording.sourcePath))}|${recording.provider}|${recording.sourcePath}`;
                if (candidate && key(candidate).localeCompare(key(first)) < 0) return this.admit(candidate, now);
            }
            trialNextId = first?.id;
        }
        if (this.config.automaticShortsEnabled && !comparison && control.trialPerProvider === null) {
            // Joining prepares future work in advance. Choose globally across
            // local stages, upload-ready work and unadmitted sources so those
            // batches cannot jump ahead of an older recording or its upload.
            const pending = order(this.database.list().filter(recording => [
                "server_ready", "remuxed", "artifact_valid", "described", "metadata_ready",
            ].includes(recording.state) && allows(recording)), control.providerFilter)[0];
            const candidate = await selectCandidate();
            const key = (recording: RecordingInput) => `${captureKeyFromFolderName(path.basename(recording.sourcePath))}|${recording.provider}|${recording.sourcePath}`;
            if (candidate && (!pending || key(candidate).localeCompare(key(pending)) < 0)) return this.admit(candidate, now);
            trialNextId = pending?.id;
        }
        const local = order(this.database.list().filter((recording) => [
            "server_ready", "remuxed", "artifact_valid", "described",
        ].includes(recording.state) && (!trialNextId || recording.id === trialNextId)
            && allows(recording)), control.providerFilter);
        // A local stage waiting for a resource (memory, a disk trim, a model that would not
        // start) holds only that recording: an already prepared upload still goes ahead.
        let deferred: CampaignStepResult | undefined;
        if (local[0]) {
            this.database.enrollCampaignTrial(local[0], now);
            try {
                await verifyCurrentServerAuthority(local[0], this.config, this.database);
                const resolutionResult = await this.enforceCurrentResolutionPolicy(local[0], now);
                if (resolutionResult) return resolutionResult;
            } catch (error) {
                if (await cancelInvalidShortBatch(this.database, this.config, local[0].id, String(error), now)) {
                    return { disposition: "stage_completed", recordingId: local[0].id, state: "short_cancelled" };
                }
                if (comparison) this.database.setCampaignState("paused", now);
                return {
                    disposition: "attention_required",
                    recordingId: local[0].id,
                    reason: error instanceof Error ? error.message : String(error),
                };
            }
            // Authority checks above yield to the file watcher. Recheck before
            // the synchronous stage claim so a just-cancelled pending entry
            // cannot slip into a conversion from this step's stale snapshot.
            if (comparison && !this.database.comparisonAllows(local[0])) {
                return { disposition: "idle", reviewRequired };
            }
            let result;
            try {
                await this.ensureProvenance(local[0], now);
                result = await this.orchestrator.processRecording(local[0].id, now);
            } catch (error) {
                if (!(error instanceof StageDeferredError)) throw error;
                deferred = { disposition: "resource_wait", recordingId: local[0].id, reason: error.message };
            }
            if (!deferred) {
                if (!result) throw new Error(`Could not claim campaign recording ${local[0].id}`);
                if (comparison && ["failed", "blocked", "provenance_review_required"].includes(result.state)) {
                    this.database.setCampaignState("paused", now);
                }
                return { disposition: "stage_completed", recordingId: result.id, state: result.state };
            }
        }

        // Oldest first, except that a wait on the oldest's local stage does not hold back an
        // upload already prepared (a trial keeps its strict order).
        const uploadReady = order(this.database.list("metadata_ready")
            .filter((recording) => (!trialNextId || recording.id === trialNextId || (deferred !== undefined && control.trialPerProvider === null))
                && allows(recording) && this.database.canAttemptUpload(recording.id, now)), control.providerFilter)[0];
        if (uploadReady) return await this.uploadPrepared(uploadReady, control, comparison, now);
        // Nothing to upload meanwhile: the wait is this step's outcome (no new admissions).
        if (deferred) return deferred;

        const candidate = await selectCandidate();
        if (!candidate) {
            if (comparison) {
                const selected = comparison.selection.map((source) => this.database.getBySourcePath(source.sourcePath));
                if (selected.some((recording) => !recording || !allows(recording)
                    || ["failed", "blocked", "provenance_review_required"].includes(recording.state))) {
                    this.database.setCampaignState("paused", now);
                    return { disposition: "comparison_attention_required", reason: "Selected recording failed, changed, or requires review; no replacement will be admitted" };
                }
                if (selected.some((recording) => recording?.state !== "upload_verified")) {
                    return { disposition: "comparison_verification_wait" };
                }
                for (const recording of selected) {
                    const artifact = this.database.getArtifact(recording!.id);
                    if (!artifact || !await access(artifact.path).then(() => true, () => false)) {
                        this.database.setCampaignState("paused", now);
                        return { disposition: "comparison_attention_required", reason: "Comparison artifact is missing; trial cannot be considered complete" };
                    }
                }
                this.database.finishComparisonTrial(comparison.selection.length, now);
                return { disposition: "comparison_finished" };
            }
            if (control.trialPerProvider !== null) {
                const trial = this.database.getCampaignTrialProgress(sourcesOf(this.config));
                const pending = trial.flatMap((provider) => provider.recordings);
                if (pending.some((recording) => ["upload_admitted", "uploading", "uploaded", "upload_uncertain"].includes(recording.state))) {
                    // Verification runs inline even without new campaign work.
                    // Confirmed absence can return the same slot to metadata_ready
                    // for retry; never substitute an extra recording for it.
                    return { disposition: "trial_verification_wait", reviewRequired, trial };
                }
                if (trial.some((provider) => provider.admitted < control.trialPerProvider!)
                    || pending.some((recording) => !["upload_verified", "cleanup_eligible"].includes(recording.state))) {
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
