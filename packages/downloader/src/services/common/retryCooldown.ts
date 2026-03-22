import logger from "../../common/logger.js";
import { ZERO_SEGMENT_COOLDOWN_MS } from "../../common/timing.js";

export class RetryCooldown {
    private cooldownUntil = new Map<string, number>();
    private label: string;

    constructor(label: string) {
        this.label = label;
    }

    public recordFailure(id: string): void {
        this.cooldownUntil.set(id, Date.now() + ZERO_SEGMENT_COOLDOWN_MS);
        logger.warn(`[${this.label}] ${id}: download failed. Cooldown ${ZERO_SEGMENT_COOLDOWN_MS / 1000}s`);
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
