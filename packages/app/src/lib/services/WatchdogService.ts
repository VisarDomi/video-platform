/**
 * WatchdogService
 * Detects if the JS event loop has paused (tab backgrounded, phone locked, iOS freeze)
 * by measuring drift between expected and actual interval execution time.
 */
export class WatchdogService {
	private lastTick = 0;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private readonly TOLERANCE_MS = 2500;
	private readonly TICK_MS = 1000;
	private onFreeze: ((gap: number) => void) | null = null;

	setOnFreeze(callback: (gap: number) => void) {
		this.onFreeze = callback;
	}

	start() {
		this.stop();
		this.lastTick = Date.now();

		this.intervalId = setInterval(() => {
			const now = Date.now();
			const delta = now - this.lastTick;

			if (delta > this.TICK_MS + this.TOLERANCE_MS) {
				const gap = delta - this.TICK_MS;
				console.warn(`[Watchdog] Freeze detected. Gap: ${gap}ms`);
				this.onFreeze?.(gap);
			}

			this.lastTick = now;
		}, this.TICK_MS);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}
}
