const QUIET_MS = 100;
const MAX_FRAME_GAP_MS = 50;
const POSITION_EPSILON = 0.1;

// Activity-only sampling. A long main-thread stall is not evidence that native
// scrolling stopped: require a fresh, continuously sampled quiet window.
export class PositionSettlement {
	private frame: number | undefined;

	constructor(
		private readonly readPosition: () => readonly number[],
		private readonly onSettled: () => void
	) {}

	watch(): void {
		if (this.frame !== undefined) return;
		let anchor = this.readPosition();
		let quietSince = performance.now();
		let previousFrame = quietSince;
		const sample = (now: number): void => {
			const position = this.readPosition();
			if (now - previousFrame > MAX_FRAME_GAP_MS ||
				position.some((value, index) => Math.abs(value - anchor[index]) >= POSITION_EPSILON)) {
				anchor = position;
				quietSince = now;
			}
			previousFrame = now;
			if (now - quietSince >= QUIET_MS) {
				this.frame = undefined;
				this.onSettled();
			} else {
				this.frame = requestAnimationFrame(sample);
			}
		};
		this.frame = requestAnimationFrame(sample);
	}

	cancel(): void {
		if (this.frame !== undefined) cancelAnimationFrame(this.frame);
		this.frame = undefined;
	}
}
