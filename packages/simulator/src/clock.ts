// The simulator's notion of "now". Everything time-dependent reads it, so a
// test (or the control API) can move time without waiting for it.

export interface Clock {
    /** Milliseconds since the Unix epoch. */
    now(): number;
}

export type ClockMode = "real" | "manual";

export type ClockSnapshot = { mode: "real"; offsetMs: number } | { mode: "manual"; at: number };

/**
 * Real time plus an offset by default. In manual mode time stands still until
 * `advance` or `set` moves it. Switching modes keeps the current instant.
 */
export class SimClock implements Clock {
    private offsetMs = 0;
    private frozenAt: number | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(
        options: { mode?: ClockMode; at?: number } = {},
        private readonly realNow: () => number = Date.now,
    ) {
        // Read real time once: two reads can straddle a millisecond tick, and a
        // manual clock "at T" would then stand at T+1 (everything a test or a
        // checker asks about T would be off by that millisecond).
        const real = this.realNow();
        if (options.at !== undefined) this.offsetMs = options.at - real;
        if (options.mode === "manual") this.frozenAt = options.at ?? real;
    }

    now(): number {
        return this.frozenAt ?? this.realNow() + this.offsetMs;
    }

    get mode(): ClockMode {
        return this.frozenAt === null ? "real" : "manual";
    }

    setMode(mode: ClockMode): void {
        if (mode === this.mode) return;
        if (mode === "manual") {
            this.frozenAt = this.now();
        } else {
            this.offsetMs = this.frozenAt! - this.realNow();
            this.frozenAt = null;
        }
        this.emit();
    }

    advance(ms: number): number {
        if (!Number.isFinite(ms) || ms < 0) throw new RangeError("advance takes a non-negative number of milliseconds");
        if (this.frozenAt !== null) this.frozenAt += ms;
        else this.offsetMs += ms;
        this.emit();
        return this.now();
    }

    set(at: number): number {
        if (!Number.isFinite(at)) throw new RangeError("set takes epoch milliseconds");
        if (this.frozenAt !== null) this.frozenAt = at;
        else this.offsetMs = at - this.realNow();
        this.emit();
        return this.now();
    }

    /** What to persist so a restarted simulator keeps the same timeline. */
    snapshot(): ClockSnapshot {
        return this.frozenAt === null ? { mode: "real", offsetMs: this.offsetMs } : { mode: "manual", at: this.frozenAt };
    }

    static restore(snapshot: ClockSnapshot, realNow: () => number = Date.now): SimClock {
        const clock = new SimClock({}, realNow);
        if (snapshot.mode === "manual") clock.frozenAt = snapshot.at;
        else clock.offsetMs = snapshot.offsetMs;
        return clock;
    }

    /** Called after every explicit move (not for the passage of real time). */
    onMove(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of this.listeners) listener();
    }
}
