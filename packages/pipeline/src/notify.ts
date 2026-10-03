import { spawn } from "node:child_process";

const REPEAT_AFTER_MILLISECONDS = 6 * 60 * 60_000;
const lastSent = new Map<string, number>();

// Desktop notification for events that need a person (campaign paused or in
// a cooldown, provider removed a video, session lost). Only the managed worker
// notifies; the same message is not repeated within six hours.
export function notifyDesktop(title: string, body: string, urgent = false, now = Date.now()): boolean {
    if (process.env.VIDEO_PIPELINE_SERVICE_MODE !== "1" || process.env.VIDEO_PIPELINE_NOTIFY === "0") return false;
    const key = `${title}\n${body}`;
    if (now - (lastSent.get(key) ?? 0) < REPEAT_AFTER_MILLISECONDS) return false;
    lastSent.set(key, now);
    try {
        const child = spawn("notify-send", ["-a", "Video pipeline", ...(urgent ? ["-u", "critical"] : []), title, body.slice(0, 400)],
            { stdio: "ignore", detached: true });
        child.on("error", () => undefined);
        child.unref();
    } catch { /* No desktop session: the journal still has the event. */ }
    return true;
}

// Which campaign step results deserve a notification, and how they read.
export function stepNotification(step: { disposition?: string; recordingId?: string; reason?: string; resumeAt?: string;
    rejectedPhrases?: readonly string[] } | undefined): { title: string; body: string; urgent: boolean } | null {
    const recording = step?.recordingId ? ` (${step.recordingId})` : "";
    switch (step?.disposition) {
        case "attention_required":
            return { title: "Pipeline paused: needs you", body: `${step.reason ?? "attention required"}${recording}`, urgent: true };
        case "antibot_cooldown":
        case "daily_limit_cooldown":
        case "upload_retry_cooldown":
            return { title: "Pipeline in a cooldown", body: `${step.reason ?? step.disposition} until ${step.resumeAt ?? "?"}${recording}`, urgent: false };
        case "metadata_rejected":
            return { title: "Provider rejected words in a description", body: `${(step.rejectedPhrases ?? []).join(", ")}${recording}; describing again`, urgent: false };
        default:
            return null;
    }
}
