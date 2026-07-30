export interface GestureCallbacks {
	getCurrentTime(): number;
	getSeekMax(): number;
	seekDirect(time: number): void;
	finishSeek(): void;
	onVerticalStart(): void;
	setControlsVisible(visible: boolean): void;
}

export class GestureController {
	private startX = 0;
	private startY = 0;
	private axis: 'none' | 'x' | 'y' | 'browser' = 'none';
	private seekBase = 0;

	private readonly edgeWidth = 28;
	private readonly seekSecondsPerWidth = 60;

	constructor(
		private readonly target: HTMLElement,
		private readonly callbacks: GestureCallbacks
	) {
		target.addEventListener('touchstart', this.handleStart, { passive: true, capture: true });
		target.addEventListener('touchmove', this.handleMove, { passive: false, capture: true });
		target.addEventListener('touchend', this.handleEnd, { capture: true });
		target.addEventListener('touchcancel', this.handleCancel, { capture: true });
	}

	private readonly handleStart = (event: TouchEvent): void => {
		if (event.touches.length > 1) {
			this.axis = 'browser';
			return;
		}
		if (event.touches.length !== 1) return;
		const touch = event.touches[0];
		this.startX = touch.clientX;
		this.startY = touch.clientY;
		this.axis = touch.clientX <= this.edgeWidth ? 'browser' : 'none';
		this.seekBase = this.callbacks.getCurrentTime();
	};

	private readonly handleMove = (event: TouchEvent): void => {
		if (this.axis === 'browser') return;
		if (event.touches.length > 1) {
			this.axis = 'browser';
			return;
		}
		if (event.touches.length !== 1) return;
		const dx = event.touches[0].clientX - this.startX;
		const dy = event.touches[0].clientY - this.startY;
		if (this.axis === 'none') {
			if (Math.max(Math.abs(dx), Math.abs(dy)) <= 8) return;
			this.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
			if (this.axis === 'y') {
				this.callbacks.onVerticalStart();
			}
		}

		if (this.axis === 'x' && this.startY < innerHeight / 2) {
			event.preventDefault();
			const max = this.callbacks.getSeekMax();
			if (max > 0) {
				const target = this.seekBase + (dx / innerWidth) * this.seekSecondsPerWidth;
				this.callbacks.seekDirect(Math.max(0, Math.min(max, target)));
			}
		}
	};

	private readonly handleEnd = (event: TouchEvent): void => {
		if (this.axis === 'browser') {
			if (event.touches.length === 0) this.axis = 'none';
			return;
		}
		const touch = event.changedTouches[0];
		const dx = touch.clientX - this.startX;
		if (this.axis === 'x' && this.startY < innerHeight / 2) this.callbacks.finishSeek();
		else if (this.axis === 'x' && Math.abs(dx) > 80) {
			this.callbacks.setControlsVisible(dx > 0);
		}
		this.axis = 'none';
	};

	private readonly handleCancel = (): void => {
		this.axis = 'none';
	};
}
