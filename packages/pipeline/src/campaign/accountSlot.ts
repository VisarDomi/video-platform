// The account slot: one upload or uploads-list scan at a time on the destination account,
// whichever network it leaves from. The home upload step, the daily verification and the
// office lane each take it; conversion never does. It lives in the worker process, the
// only one that uploads while the worker runs (manual upload commands refuse to run then).
export class AccountSlot {
    private holder: string | null = null;
    private readonly waiting: Array<() => void> = [];

    get heldBy(): string | null { return this.holder; }

    // Takes the slot if it is free; the release function gives it back (once).
    tryTake(owner: string): (() => void) | null {
        if (this.holder !== null) return null;
        this.holder = owner;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.holder = null;
            this.waiting.shift()?.();
        };
    }

    // Waits for the slot (or the signal), then takes it.
    async take(owner: string, signal?: AbortSignal): Promise<() => void> {
        for (;;) {
            const release = this.tryTake(owner);
            if (release) return release;
            if (signal?.aborted) throw signal.reason ?? new Error("stopped while waiting for the account slot");
            await new Promise<void>((resolve) => {
                const wake = () => { signal?.removeEventListener("abort", wake); resolve(); };
                this.waiting.push(wake);
                signal?.addEventListener("abort", wake, { once: true });
            });
        }
    }

    // Runs action holding the slot, or returns null at once when another holds it.
    async ifFree<T>(owner: string, action: () => Promise<T> | T): Promise<{ value: T } | null> {
        const release = this.tryTake(owner);
        if (!release) return null;
        try { return { value: await action() }; } finally { release(); }
    }
}
