import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { journalPriority } from "shared";
import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { cleanupAcceptedConversions } from "./acceptedConversions.js";
import { reconcileDueUploads } from "./reconcileUploads.js";
import { campaignStep } from "./campaign.js";
import { syncComparisonSelection, writeComparisonReport } from "./comparisonTrial.js";
import type { DestinationSessionCheck } from "sdk";
import { createProviderUploader } from "../upload/providerFactory.js";
import { notifyDesktop, stepNotification } from "../notify.js";
import { recoveryInProgress, readRecoveryState } from "../upload/sessionRecoveryState.js";
import { access } from "node:fs/promises";
import { AccountSlot } from "../campaign/accountSlot.js";
import { runCarrierLane } from "../uplink/carrierLane.js";
import { runOfficeLane } from "../uplink/officeLane.js";
import type { CampaignLane } from "../campaign/campaignWorker.js";
import { keepDescriptionModelLoaded } from "../stages/descriptionModel.js";

const IDLE_POLL_MILLISECONDS = 30_000;
// Well inside common PHP session idle limits; one light request each time.
const SESSION_KEEPALIVE_MILLISECONDS = 10 * 60_000;

// Keeps a destination's shared session (Destination.session.keepAlive) from idling out
// and records its health; the history answers how long the destination keeps a session
// alive. A logged-out session pauses the campaign with its reason instead of logging in
// again, which would log the other device out; once a recovery restored it, the campaign
// resumes. Destinations without a shared session are left alone.
export async function keepDestinationSessionAlive(config: PipelineConfig, now = new Date(),
    // The destination's own light session check (a test passes one).
    check?: () => Promise<DestinationSessionCheck>): Promise<void> {
    if (!config.networkUploadsEnabled) return;
    const database = new PipelineDatabase(config.databasePath);
    try {
        const provider = config.uploadProvider ?? database.getActiveUploadProvider();
        if (await recoveryInProgress(config.databasePath, provider)) return;
        let destination;
        try {
            destination = await createProviderUploader(config, provider);
        } catch (error) {
            // A broken sites file or plug-in build: the session's health is unknown.
            database.recordProviderSessionEvent({ provider, kind: "keepalive_error",
                note: error instanceof Error ? error.message : String(error) }, now);
            return;
        }
        const keepAlive = destination.session.keepAlive;
        if (!keepAlive) return;
        const { label } = keepAlive, advice = destination.session.lostAdvice;
        const before = database.getCampaignControl();
        let result;
        try {
            result = await (check ?? (() => destination.session.check()))();
        } catch (error) {
            database.recordProviderSessionEvent({ provider, kind: "keepalive_error",
                note: error instanceof Error ? error.message : String(error) }, now);
            return;
        }
        database.recordProviderSessionEvent({ provider, kind: "keepalive", loggedIn: result.loggedIn,
            fingerprint: result.fingerprint, passwordLoginAt: result.passwordLoginAt, note: result.note }, now);
        if (await recoveryInProgress(config.databasePath, provider)) return;
        const manuallyHeld = await access(path.join(path.dirname(config.databasePath), "user-pause.json")).then(() => true, () => false);
        const recovery = await readRecoveryState(config.databasePath, provider);
        const control = database.getCampaignControl();
        if (result.loggedIn && !manuallyHeld && (!recovery.status || recovery.status === "healthy")
            && before.state === "paused" && before.resumeAt === null
            && before.attentionReason?.startsWith(`${label} `) && before.attentionReason.includes(advice)
            && control.updatedAt === before.updatedAt && control.attentionReason === before.attentionReason
            && control.state === "paused") {
            database.setCampaignState("running", now);
            console.log(JSON.stringify({ event: `${provider}-session-recovered`, fingerprint: result.fingerprint, campaign: "running" }));
        }
        if (!result.loggedIn && database.getCampaignControl().state === "running") {
            database.pauseForAttention(`${label} shared session is logged out (${result.note}); ${advice}`, now);
            console.log(journalPriority("error") + JSON.stringify({ event: `${provider}-session-lost`, note: result.note, fingerprint: result.fingerprint }));
            notifyDesktop(`${label} session lost: pipeline paused`, `${result.note}. Run: ${keepAlive.restoreCommand}`, true);
        }
    } finally {
        database.close();
    }
}

// Lanes waiting for work, woken when another lane finished a stage (the recording it handed
// on may be the waiting lane's next).
export class LaneWakeup {
    private readonly waiting = new Set<() => void>();
    notify(): void {
        for (const wake of [...this.waiting]) wake();
    }
    add(wake: () => void): () => void {
        this.waiting.add(wake);
        return () => this.waiting.delete(wake);
    }
}

function wait(milliseconds: number, signal: AbortSignal, wakeup?: LaneWakeup): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, milliseconds);
        const remove = wakeup?.add(done);
        function done() {
            clearTimeout(timer);
            remove?.();
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done, { once: true });
    });
}

// The destination uploads go to: the configured one, else the ledger's active one.
function activeDestination(config: PipelineConfig): string {
    if (config.uploadProvider) return config.uploadProvider;
    const database = new PipelineDatabase(config.databasePath);
    try {
        return database.getActiveUploadProvider();
    } finally {
        database.close();
    }
}

function confirmationsAreDue(config: PipelineConfig): boolean {
    const database = new PipelineDatabase(config.databasePath);
    try {
        return database.dueUploadConfirmations().length > 0;
    } finally {
        database.close();
    }
}

// Temporary files of remux.ts (`<artifact>.<uuid>.partial.mp4`) and
// artifactCache.ts (`<artifact>.<uuid>.cache-partial`) in the staging root.
async function removePartialArtifacts(stagingRoot: string): Promise<Array<{ name: string; bytes: number }>> {
    const entries = await readdir(stagingRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    const removed: Array<{ name: string; bytes: number }> = [];
    for (const entry of entries) {
        if (!entry.isFile() || !/\.[0-9a-f-]{36}\.(partial\.mp4|cache-partial)$/.test(entry.name)) continue;
        const filePath = path.join(stagingRoot, entry.name);
        const bytes = (await stat(filePath)).size;
        await unlink(filePath);
        removed.push({ name: entry.name, bytes });
    }
    return removed;
}

export async function recoverWorkerAtBoot(config: PipelineConfig, signal: AbortSignal,
    cleanup = cleanupAcceptedConversions, heartbeatMilliseconds = 30_000): Promise<void> {
    const database = new PipelineDatabase(config.databasePath);
    database.writeWorkerHeartbeat();
    const heartbeat = setInterval(() => database.writeWorkerHeartbeat(), heartbeatMilliseconds);
    try {
        database.recoverInterruptedUploads();
        database.recoverAcceptedVerifications();
        database.releasePlaceholderReferences();
        const cleared = database.releaseAllLeases();
        const cleaned = await cleanup(database, config, new Date(), signal);
        if (cleaned.length) console.log(JSON.stringify({ event: "accepted-conversion-cleanup", results: cleaned }));
        if (cleared > 0) console.log(JSON.stringify({ event: "campaign-boot-clear-leases", cleared }));
    } finally {
        clearInterval(heartbeat);
        database.close();
    }
}

export async function runCampaignWorker(config: PipelineConfig, signal: AbortSignal, slot = new AccountSlot()): Promise<void> {
    // Boot recovery is single-flight but still reports liveness and can be stopped.
    await recoverWorkerAtBoot(config, signal);
    if (signal.aborted) return;
    // Half-written conversions/cache copies are not adoptable completed artifacts.
    const partials = await removePartialArtifacts(config.stagingRoot);
    if (partials.length > 0) console.log(JSON.stringify({ event: "campaign-boot-clear-partials", removed: partials }));
    // Heartbeat on its own timer so manual *-one commands can tell the
    // campaign is alive even mid-step (a single step can take minutes).
    // Reuse one lightweight connection instead of re-opening the ledger every 30 s.
    const heartbeatDatabase = new PipelineDatabase(config.databasePath);
    heartbeatDatabase.writeWorkerHeartbeat();
    const heartbeat = setInterval(() => {
        try {
            heartbeatDatabase.writeWorkerHeartbeat();
        } catch (error) {
            console.error(journalPriority("warn") + JSON.stringify({ event: "worker-heartbeat-error", error: String(error) }));
        }
    }, 30_000);
    signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        try { heartbeatDatabase.close(); } catch {}
    }, { once: true });
    let keepingAlive = false;
    const keepalive = () => {
        if (keepingAlive || signal.aborted) return;
        keepingAlive = true;
        void keepDestinationSessionAlive(config).catch((error: unknown) => {
            let provider = "session";
            try { provider = activeDestination(config); } catch { /* The ledger is what failed. */ }
            console.error(journalPriority("error", 2) + JSON.stringify({ event: `${provider}-keepalive-error`, error: String(error) }));
        }).finally(() => { keepingAlive = false; });
    };
    keepalive();
    const keepaliveTimer = setInterval(keepalive, SESSION_KEEPALIVE_MILLISECONDS);
    signal.addEventListener("abort", () => clearInterval(keepaliveTimer), { once: true });
    // Queue ingestion is independent of long conversions and network cooldowns.
    // It never changes running/paused intent; pending removals follow the file.
    let importingSelection = false;
    let lastSelectionErrors = "";
    const selectionWatch = setInterval(() => {
        if (!config.comparisonTrialOnly || importingSelection || signal.aborted) return;
        importingSelection = true;
        void (async () => {
            try {
                const result = await syncComparisonSelection(config);
                const errors = JSON.stringify(result.errors);
                if (result.added > 0 || result.removed > 0 || errors !== lastSelectionErrors) {
                    console.log(JSON.stringify({ event: "comparison-selection", ...result }));
                    lastSelectionErrors = errors;
                }
                await writeComparisonReport(config);
            } catch (error) {
                console.error(journalPriority("error", 2) + JSON.stringify({ event: "comparison-selection-error", error: String(error) }));
            } finally { importingSelection = false; }
        })();
    }, 30_000);
    signal.addEventListener("abort", () => clearInterval(selectionWatch), { once: true });
    // A waiting step (paused, idle, a cooldown) repeats every 30 seconds (sooner when another
    // lane hands on work) and a pending verification is rechecked until it settles: each is
    // logged when it changes, not on every repetition.
    // The carrier lane runs beside the main loop (the drive copies while conversion runs).
    const carrierLane = config.uplink ? runCarrierLane(config, signal, (_notice, title, body) => notifyDesktop(title, body))
        .catch((error: unknown) => console.error(journalPriority("error", 2) + JSON.stringify({ event: "carrier-lane-error", error: String(error) })))
        : Promise.resolve();
    let verificationHold: string | null = null;
    // The office lane uploads from the other uplink beside the main loop, sharing the slot.
    const officeLane = config.uplink ? runOfficeLane(config, signal, slot, (_notice, title, body) => notifyDesktop(title, body, true),
        () => verificationHold)
        .catch((error: unknown) => console.error(journalPriority("error", 2) + JSON.stringify({ event: "office-lane-error", error: String(error) })))
        : Promise.resolve();
    const reconcileOutcomes = new Map<string, string>();
    const wakeup = new LaneWakeup();
    // With a second uplink, conversion, description and upload each run in their own lane,
    // on their own recording, at the same time; the model stays loaded between descriptions
    // (unloaded by a manual pause). Without one, one serial loop takes whichever step is due.
    const model = config.uplink ? keepDescriptionModelLoaded() : null;
    const lane = async (name: CampaignLane | undefined): Promise<void> => {
        let lastStep = "";
        let waitingForRecovery = false;
        const uploads = name === undefined || name === "upload";
        while (!signal.aborted) {
            try {
                if (uploads && await recoveryInProgress(config.databasePath, activeDestination(config))) {
                    waitingForRecovery = true;
                    await wait(1_000, signal);
                    continue;
                }
                if (waitingForRecovery) {
                    waitingForRecovery = false;
                    await keepDestinationSessionAlive(config);
                }
                if (uploads && config.networkUploadsEnabled && confirmationsAreDue(config)) {
                    const release = await slot.take("verification", signal);
                    try {
                        const reconciled = await reconcileDueUploads(config) as { results?: Array<{ disposition?: string; recordingId?: string; remoteId?: string; reason?: string }> };
                        const changed = (reconciled.results ?? []).filter((item) => {
                            const outcome = `${item.disposition}\u0000${item.reason ?? ""}`;
                            if (reconcileOutcomes.get(item.recordingId ?? "") === outcome) return false;
                            reconcileOutcomes.set(item.recordingId ?? "", outcome);
                            return true;
                        });
                        if (changed.length > 0) console.log(JSON.stringify({ event: "campaign-reconcile", result: { ...reconciled, results: changed } }));
                        verificationHold = null;
                    } catch (error) {
                        // Without a second uplink a failed verification stops the step (and the
                        // conversions with it); with one, it holds uploads only.
                        if (!config.uplink) throw error;
                        const message = error instanceof Error ? error.message : String(error);
                        if (verificationHold === null) console.error(journalPriority("warn") + JSON.stringify({ event: "campaign-reconcile-error", error: message }));
                        verificationHold = `the daily verification failed: ${message}`;
                    } finally { release(); }
                }
                const result = await campaignStep(config, { slot, uploadHold: verificationHold, ...(name ? { lane: name } : {}) }) as {
                    step?: { disposition?: string; resumeAt?: string };
                };
                const step = JSON.stringify(result);
                if (step !== lastStep) console.log(JSON.stringify({ event: "campaign-step", ...(name ? { lane: name } : {}), result }));
                lastStep = step;
                const notice = stepNotification(result.step as Parameters<typeof stepNotification>[0]);
                if (notice) notifyDesktop(notice.title, notice.body, notice.urgent);
                const disposition = result.step?.disposition;
                // A manual pause frees the GPU and the memory the model holds.
                if (name === "describe" && disposition === "paused" && model?.loaded) await model.unload();
                if ((disposition === "antibot_cooldown" || disposition === "daily_limit_cooldown" || disposition === "upload_retry_cooldown")
                    && result.step?.resumeAt && !config.uplink) {
                    const resumeAt = Date.parse(result.step.resumeAt);
                    if (Number.isFinite(resumeAt)) {
                        // Keep verification and queue watching alive during an
                        // upload cooldown; durable campaign state gates uploads.
                        await wait(Math.min(IDLE_POLL_MILLISECONDS, Math.max(0, resumeAt - Date.now())), signal);
                        continue;
                    }
                }
                if (disposition === "admitted" || disposition === "stage_completed"
                    || disposition === "upload_completed" || disposition === "shorts_joined" || disposition === "shorts_waiting") {
                    wakeup.notify();
                    continue;
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(journalPriority("error", 2) + JSON.stringify({ event: "campaign-error", ...(name ? { lane: name } : {}), error: message }));
                notifyDesktop("Pipeline error", message, true);
            }
            await wait(IDLE_POLL_MILLISECONDS, signal, wakeup);
        }
    };
    await Promise.all(config.uplink ? [lane("convert"), lane("describe"), lane("upload")] : [lane(undefined)]);
    await model?.unload();
    // A copy in progress ends at its next step (a killed one leaves only a .partial file,
    // which the next pass deletes).
    await Promise.all([carrierLane, officeLane]);
}
