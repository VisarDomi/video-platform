export interface GestureCallbacks {
	getCurrentTime(): number;
	getSeekMax(): number;
	seekDirect(time: number): void;
	finishSeek(): void;
	onVerticalStart(): void;
	setControlsVisible(visible: boolean): void;
	applyZoom(scale: number, x: number, y: number): void;
	resetZoom(): void;
}

export class GestureController {
	private startX = 0;
	private startY = 0;
	private axis: 'none' | 'x' | 'y' | 'pinch' | 'browser' = 'none';
	private seekBase = 0;
	private zoomScale = 1;
	private zoomX = 0;
	private zoomY = 0;
	private pinchDistance = 0;
	private pinchScale = 1;
	private pinchCenterX = 0;
	private pinchCenterY = 0;
	private pinchZoomX = 0;
	private pinchZoomY = 0;

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
		if (event.touches.length === 2) {
			this.startPinch(event.touches[0], event.touches[1]);
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
		if (event.touches.length === 2) {
			event.preventDefault();
			if (this.axis !== 'pinch') this.startPinch(event.touches[0], event.touches[1]);
			this.updatePinch(event.touches[0], event.touches[1]);
			return;
		}
		if (event.touches.length !== 1 || this.axis === 'pinch') return;
		const dx = event.touches[0].clientX - this.startX;
		const dy = event.touches[0].clientY - this.startY;
		if (this.axis === 'none') {
			if (Math.max(Math.abs(dx), Math.abs(dy)) <= 8) return;
			this.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
			if (this.axis === 'y') {
				if (this.zoomScale > 1) this.resetZoom();
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
			this.axis = 'none';
			return;
		}
		if (this.axis === 'pinch') {
			if (event.touches.length === 0 && this.zoomScale < 1.05) this.resetZoom();
			this.axis = 'none';
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

	private startPinch(first: Touch, second: Touch): void {
		this.axis = 'pinch';
		this.pinchDistance = distance(first, second);
		this.pinchScale = this.zoomScale;
		const center = touchCenter(first, second);
		this.pinchCenterX = center.x;
		this.pinchCenterY = center.y;
		this.pinchZoomX = this.zoomX;
		this.pinchZoomY = this.zoomY;
	}

	private updatePinch(first: Touch, second: Touch): void {
		const center = touchCenter(first, second);
		const scale = Math.max(
			1,
			Math.min(4, this.pinchScale * (distance(first, second) / this.pinchDistance))
		);
		const maxX = ((scale - 1) * innerWidth) / 2;
		const maxY = ((scale - 1) * innerHeight) / 2;
		this.zoomScale = scale;
		this.zoomX = clamp(this.pinchZoomX + center.x - this.pinchCenterX, -maxX, maxX);
		this.zoomY = clamp(this.pinchZoomY + center.y - this.pinchCenterY, -maxY, maxY);
		this.callbacks.applyZoom(scale, this.zoomX, this.zoomY);
	}

	private resetZoom(): void {
		this.zoomScale = 1;
		this.zoomX = 0;
		this.zoomY = 0;
		this.callbacks.resetZoom();
	}
}

function distance(first: Touch, second: Touch): number {
	return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function touchCenter(first: Touch, second: Touch): { x: number; y: number } {
	return {
		x: (first.clientX + second.clientX) / 2,
		y: (first.clientY + second.clientY) / 2
	};
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}
