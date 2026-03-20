import logger from "../../common/logger.js";

const INITIAL_COOLDOWN_MS = 30_000;   // 30s after first failure
const MAX_COOLDOWN_MS = 10 * 60_000;  // 10 minutes cap

interface CooldownEntry {
    failCount: number;
    cooldownUntil: number; // Date.now() timestamp
}

/**
 * Provider-agnostic cooldown tracker for download retries.
 * Prevents infinite retry loops when a streamer's download keeps failing.
 *
 * Ownership: one instance per discovery service. Each discovery service
 * composes with this rather than implementing its own cooldown logic.
 *
 * Usage:
 *   if (cooldown.isActive(id)) continue;          // skip this poll cycle
 *   cooldown.recordFailure(id);                    // download failed
 *   cooldown.clear(id);                            // download succeeded
 */
export class RetryCooldown {
    private entries = new Map<string, CooldownEntry>();
    private label: string;

    constructor(label: string) {
        this.label = label;
    }

    public recordFailure(id: string): void {
        const existing = this.entries.get(id);
        const failCount = (existing?.failCount ?? 0) + 1;
        const cooldownMs = Math.min(INITIAL_COOLDOWN_MS * Math.pow(2, failCount - 1), MAX_COOLDOWN_MS);
        this.entries.set(id, {
            failCount,
            cooldownUntil: Date.now() + cooldownMs,
        });
        logger.warn(`[${this.label}] ${id}: download failed (attempt ${failCount}). Cooldown ${(cooldownMs / 1000).toFixed(0)}s`);
    }

    public clear(id: string): void {
        this.entries.delete(id);
    }

    public isActive(id: string): boolean {
        const entry = this.entries.get(id);
        if (!entry) return false;
        return Date.now() < entry.cooldownUntil;
    }
}
