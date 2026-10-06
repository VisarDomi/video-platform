import { journalPriority } from "shared";
import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { reconcileDueUploads } from "./reconcileUploads.js";
import { campaignStep } from "./campaign.js";
import { syncComparisonSelection, writeComparisonReport } from "./comparisonTrial.js";
import { checkPorntrexSession } from "../upload/porntrexKeepalive.js";
import { SESSION_LOST_ADVICE } from "../upload/providerWarnings.js";
import { notifyDesktop, stepNotification } from "../notify.js";

const IDLE_POLL_MILLISECONDS = 30_000;
// Well inside common PHP session idle limits; one light request each time.
const SESSION_KEEPALIVE_MILLISECONDS = 10 * 60_000;

// Keeps the shared Porntrex session from idling out and records its health
// (the history answers how long porntrex keeps a session alive). A logged-out
// session pauses the campaign with its reason instead of logging in again,
// which would log the phone out.
export async function keepPorntrexSessionAlive(config: PipelineConfig, now = new Date(),
    check = checkPorntrexSession): Promise<void> {
    if (!config.networkUploadsEnabled || !config.porntrexSessionPath) return;
    const database = new PipelineDatabase(config.databasePath);
    try {
        if ((config.uploadProvider ?? database.getActiveUploadProvider()) !== "porntrex") return;
        let result;
        try {
            result = await check(config.porntrexSessionPath);
        } catch (error) {
            database.recordProviderSessionEvent({ provider: "porntrex", kind: "keepalive_error",
                note: error instanceof Error ? error.message : String(error) }, now);
            return;
        }
        database.recordProviderSessionEvent({ provider: "porntrex", kind: "keepalive", loggedIn: result.loggedIn,
            fingerprint: result.fingerprint, passwordLoginAt: result.passwordLoginAt, note: result.note }, now);
        if (!result.loggedIn && database.getCampaignControl().state === "running") {
            database.pauseForAttention(`Porntrex shared session is logged out (${result.note}); ${SESSION_LOST_ADVICE}`, now);
            console.log(journalPriority("error") + JSON.stringify({ event: "porntrex-session-lost", note: result.note, fingerprint: result.fingerprint }));
            notifyDesktop("Porntrex session lost: pipeline paused", `${result.note}. Run: npm run ptrex:connect-iphone`, true);
        }
    } finally {
        database.close();
    }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, milliseconds);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done, { once: true });
    });
}

function confirmationsAreDue(config: PipelineConfig): boolean {
    const database = new PipelineDatabase(config.databasePath);
    try {
        return database.dueUploadConfirmations().length > 0;
    } finally {
        database.close();
    }
}

export async function runCampaignWorker(config: PipelineConfig, signal: AbortSignal): Promise<void> {
    // The pipeline is single-flight by construction: any lease present at
    // boot belongs to a dead process. Clear them so a restart resumes
    // immediately instead of waiting out the 30-minute stage lease.
    {
        const database = new PipelineDatabase(config.databasePath);
        try {
            database.recoverAcceptedVerifications();
            database.releasePlaceholderReferences();
            const cleared = database.releaseAllLeases();
            if (cleared > 0) {
                console.log(JSON.stringify({ event: "campaign-boot-clear-leases", cleared }));
            }
        } finally {
            database.close();
        }
    }
    // Heartbeat on its own timer so manual *-one commands can tell the
    // campaign is alive even mid-step (a single step can take minutes).
    const heartbeat = setInterval(() => {
        const database = new PipelineDatabase(config.databasePath);
        try {
            database.writeWorkerHeartbeat();
        } finally {
            database.close();
        }
    }, 30_000);
    {
        const database = new PipelineDatabase(config.databasePath);
        try {
            database.writeWorkerHeartbeat();
        } finally {
            database.close();
        }
    }
    signal.addEventListener("abort", () => clearInterval(heartbeat), { once: true });
    let keepingAlive = false;
    const keepalive = () => {
        if (keepingAlive || signal.aborted) return;
        keepingAlive = true;
        void keepPorntrexSessionAlive(config).catch((error: unknown) => {
            console.error(journalPriority("error", 2) + JSON.stringify({ event: "porntrex-keepalive-error", error: String(error) }));
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
    // A waiting step (paused, idle, a cooldown) repeats every 30 seconds and a
    // pending verification is rechecked until it settles: each is logged when it
    // changes, not on every repetition.
    let lastStep = "";
    const reconcileOutcomes = new Map<string, string>();
    while (!signal.aborted) {
        try {
            if (config.networkUploadsEnabled && confirmationsAreDue(config)) {
                const reconciled = await reconcileDueUploads(config) as { results?: Array<{ disposition?: string; recordingId?: string; remoteId?: string; reason?: string }> };
                const changed = (reconciled.results ?? []).filter((item) => {
                    const outcome = `${item.disposition}\u0000${item.reason ?? ""}`;
                    if (reconcileOutcomes.get(item.recordingId ?? "") === outcome) return false;
                    reconcileOutcomes.set(item.recordingId ?? "", outcome);
                    return true;
                });
                if (changed.length > 0) console.log(JSON.stringify({ event: "campaign-reconcile", result: { ...reconciled, results: changed } }));
                for (const item of reconciled.results ?? []) {
                    if (item.disposition === "provider_removed") notifyDesktop("Provider removed an upload",
                        `${item.recordingId} (video ${item.remoteId}) is gone; blocked for your review`, true);
                }
            }
            const result = await campaignStep(config) as {
                step?: { disposition?: string; resumeAt?: string };
            };
            const step = JSON.stringify(result);
            if (step !== lastStep) console.log(JSON.stringify({ event: "campaign-step", result }));
            lastStep = step;
            const notice = stepNotification(result.step as Parameters<typeof stepNotification>[0]);
            if (notice) notifyDesktop(notice.title, notice.body, notice.urgent);
            const disposition = result.step?.disposition;
            if ((disposition === "antibot_cooldown" || disposition === "daily_limit_cooldown" || disposition === "upload_retry_cooldown")
                && result.step?.resumeAt) {
                const resumeAt = Date.parse(result.step.resumeAt);
                if (Number.isFinite(resumeAt)) {
                    // Keep verification and queue watching alive during an
                    // upload cooldown; durable campaign state gates uploads.
                    await wait(Math.min(IDLE_POLL_MILLISECONDS, Math.max(0, resumeAt - Date.now())), signal);
                    continue;
                }
            }
            if (disposition === "admitted" || disposition === "stage_completed"
                || disposition === "upload_completed") continue;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(journalPriority("error", 2) + JSON.stringify({ event: "campaign-error", error: message }));
            notifyDesktop("Pipeline error", message, true);
        }
        await wait(IDLE_POLL_MILLISECONDS, signal);
    }
}
