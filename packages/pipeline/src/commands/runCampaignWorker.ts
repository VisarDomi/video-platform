import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { reconcileDueUploads } from "./reconcileUploads.js";
import { campaignStep } from "./campaign.js";

const IDLE_POLL_MILLISECONDS = 30_000;

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
            if ((disposition === "antibot_cooldown" || disposition === "daily_limit_cooldown")
                && result.step?.resumeAt) {
                const resumeAt = Date.parse(result.step.resumeAt);
                if (Number.isFinite(resumeAt)) {
                    await wait(Math.max(0, resumeAt - Date.now()), signal);
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
