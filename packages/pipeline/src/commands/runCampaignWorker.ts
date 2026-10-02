import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { reconcileDueUploads } from "./reconcileUploads.js";
import { campaignStep } from "./campaign.js";
import { syncComparisonSelection, writeComparisonReport } from "./comparisonTrial.js";
import { checkVideoHostSession } from "../upload/videohostKeepalive.js";
import { SESSION_LOST_ADVICE } from "../upload/providerWarnings.js";

const IDLE_POLL_MILLISECONDS = 30_000;
// Well inside common PHP session idle limits; one light request each time.
const SESSION_KEEPALIVE_MILLISECONDS = 10 * 60_000;

// Keeps the shared VideoHost session from idling out and records its health
// (the history answers how long videohost keeps a session alive). A logged-out
// session pauses the campaign with its reason instead of logging in again,
// which would log the phone out.
export async function keepVideoHostSessionAlive(config: PipelineConfig, now = new Date(),
    check = checkVideoHostSession): Promise<void> {
    if (!config.networkUploadsEnabled || !config.videohostSessionPath) return;
    const database = new PipelineDatabase(config.databasePath);
    try {
        if ((config.uploadProvider ?? database.getActiveUploadProvider()) !== "videohost") return;
        let result;
        try {
            result = await check(config.videohostSessionPath);
        } catch (error) {
            database.recordProviderSessionEvent({ provider: "videohost", kind: "keepalive_error",
                note: error instanceof Error ? error.message : String(error) }, now);
            return;
        }
        database.recordProviderSessionEvent({ provider: "videohost", kind: "keepalive", loggedIn: result.loggedIn,
            fingerprint: result.fingerprint, passwordLoginAt: result.passwordLoginAt, note: result.note }, now);
        if (!result.loggedIn && database.getCampaignControl().state === "running") {
            database.pauseForAttention(`VideoHost shared session is logged out (${result.note}); ${SESSION_LOST_ADVICE}`, now);
            console.log(JSON.stringify({ event: "videohost-session-lost", note: result.note, fingerprint: result.fingerprint }));
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
        void keepVideoHostSessionAlive(config).catch((error: unknown) => {
            console.error(JSON.stringify({ event: "videohost-keepalive-error", error: String(error) }));
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
                console.error(JSON.stringify({ event: "comparison-selection-error", error: String(error) }));
            } finally { importingSelection = false; }
        })();
    }, 30_000);
    signal.addEventListener("abort", () => clearInterval(selectionWatch), { once: true });
    while (!signal.aborted) {
        try {
            if (config.networkUploadsEnabled && confirmationsAreDue(config)) {
                console.log(JSON.stringify({ event: "campaign-reconcile", result: await reconcileDueUploads(config) }));
            }
            const result = await campaignStep(config) as {
                step?: { disposition?: string; resumeAt?: string };
            };
            console.log(JSON.stringify({ event: "campaign-step", result }));
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
            console.error(JSON.stringify({
                event: "campaign-error",
                error: error instanceof Error ? error.message : String(error),
            }));
        }
        await wait(IDLE_POLL_MILLISECONDS, signal);
    }
}
