import logger from "../../common/logger.js";

// Flat cooldown — same as StreaMonitor's fixed sleep_on_error (20s).
// No exponential backoff.  If the CDN rejects us, we try again in 20s
// with a fresh session.  If the stream is truly gone, the bulk status
// check will show it as offline and we won't attempt a download at all.
const COOLDOWN_MS = 20_000;

export class RetryCooldown {
    private cooldownUntil = new Map<string, number>();
    private label: string;

    constructor(label: string) {
        this.label = label;
    }

    public recordFailure(id: string): void {
        this.cooldownUntil.set(id, Date.now() + COOLDOWN_MS);
        logger.warn(`[${this.label}] ${id}: download failed. Cooldown ${COOLDOWN_MS / 1000}s`);
    }

    public clear(id: string): void {
        this.cooldownUntil.delete(id);
    }

    public isActive(id: string): boolean {
        const until = this.cooldownUntil.get(id);
        if (!until) return false;
        return Date.now() < until;
    }
}
