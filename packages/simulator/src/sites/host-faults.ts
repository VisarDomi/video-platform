// Scenario faults of the file host and the destinations: which are in force
// at an instant. A fault with a `ratio` fails that share of seconds, the same
// seconds for the same seed (so two runs, or a restart, agree).
import { unit } from "../rng.js";

interface Timed { type: string; at: number; until?: number; ratio?: number }

export class HostFaults<F extends Timed> {
    constructor(
        private readonly site: string,
        private readonly seed: string,
        private readonly epochMs: number,
        private readonly faults: readonly F[],
    ) {}

    startMs(f: F): number { return this.epochMs + f.at * 1000; }

    /** Faults of `type` in force at `t` (window faults) that pass their ratio. */
    active<T extends F["type"]>(type: T, t: number, match: (f: Extract<F, { type: T }>) => boolean = () => true): Array<Extract<F, { type: T }>> {
        return this.faults.flatMap((f, index) => {
            if (f.type !== type) return [];
            const from = this.startMs(f);
            const until = f.until === undefined ? Infinity : this.epochMs + f.until * 1000;
            if (t < from || t >= until) return [];
            if (f.ratio !== undefined && unit(this.seed, this.site, "ratio", index, Math.floor(t / 1000)) >= f.ratio) return [];
            const typed = f as Extract<F, { type: T }>;
            return match(typed) ? [typed] : [];
        });
    }

    /** Point events of `type` that happened at or before `t`, oldest first. */
    happened<T extends F["type"]>(type: T, t: number, match: (f: Extract<F, { type: T }>) => boolean = () => true): Array<Extract<F, { type: T }>> {
        return this.faults
            .filter(f => f.type === type && this.startMs(f) <= t && match(f as Extract<F, { type: T }>))
            .sort((a, b) => a.at - b.at) as Array<Extract<F, { type: T }>>;
    }
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function humanBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}
