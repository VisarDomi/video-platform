import { appDimensions } from '$lib/state/appDimensions';

interface PlayerStore {
	isUiVisible: boolean;
	showList(): void;
}

export interface GestureCallbacks {
	getSeekBase(): number;
	getSeekMaxTime(): number;
	seekDirect(time: number): void;
	seekFinish(): void;
	navigate(direction: 1 | -1): void;
	navPeekUpdate(dy: number): void;
	navPeekRelease(dy: number, onDone: () => void): void;
	navPeekCancel(): void;
	applyZoom(scale: number, x: number, y: number): void;
	resetZoom(): void;
}

export class GestureController {
	private videoViewEl!: HTMLElement;

	private swipeStartX = 0;
	private swipeStartY = 0;
	private swipeAxis: 'none' | 'horizontal' | 'vertical' = 'none';
	private swipeType: 'none' | 'edge-back' | 'seek' | 'nav' | 'ui' | 'pinch' = 'none';
	private seekBaseTime = 0;
	private lastMultiTouchTime = 0;
	private _swipeProgress = 0;
	private navAnimating = false;
	private lockDx = 0;

	// Zoom state — persists across gestures, reset on nav or video change
	private zoomScale = 1;
	private zoomX = 0;
	private zoomY = 0;

	// Pinch tracking — per-gesture
	private pinchStartDist = 0;
	private pinchStartScale = 1;
	private pinchStartCenterX = 0;
	private pinchStartCenterY = 0;
	private pinchStartZoomX = 0;
	private pinchStartZoomY = 0;

	swipeProgress = $state(0);
	isSwiping = $state(false);
	swipeAnimating = $state(false);

	private readonly EDGE_ZONE_RATIO = 0.077;
	private readonly DEADZONE_RATIO = 0.026;
	private readonly EDGE_BACK_THRESHOLD = 0.3;
	private readonly UI_SWIPE_THRESHOLD = 80;
	private readonly SEEK_RATE = 60;
	private readonly MULTI_TOUCH_DEBOUNCE_MS = 100;
	private readonly MAX_ZOOM = 4;

	constructor(
		private store: PlayerStore,
		private callbacks: GestureCallbacks
	) {}

	init(el: HTMLElement): () => void {
		this.videoViewEl = el;

		el.addEventListener('touchstart', this.handleTouchStart);
		el.addEventListener('touchmove', this.handleTouchMove, { passive: false });
		el.addEventListener('touchend', this.handleTouchEnd);
		el.addEventListener('touchcancel', this.handleTouchCancel);

		return () => {
			el.removeEventListener('touchstart', this.handleTouchStart);
			el.removeEventListener('touchmove', this.handleTouchMove);
			el.removeEventListener('touchend', this.handleTouchEnd);
			el.removeEventListener('touchcancel', this.handleTouchCancel);
		};
	}

	resetZoom(): void {
		if (this.zoomScale !== 1 || this.zoomX !== 0 || this.zoomY !== 0) {
			this.zoomScale = 1;
			this.zoomX = 0;
			this.zoomY = 0;
			this.callbacks.resetZoom();
		}
	}

	private getTouchDistance(t1: Touch, t2: Touch): number {
		const dx = t1.clientX - t2.clientX;
		const dy = t1.clientY - t2.clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	private getTouchCenter(t1: Touch, t2: Touch): { x: number; y: number } {
		return {
			x: (t1.clientX + t2.clientX) / 2,
			y: (t1.clientY + t2.clientY) / 2
		};
	}

	private clampPan(x: number, y: number, scale: number): { x: number; y: number } {
		if (scale <= 1) return { x: 0, y: 0 };
		const maxX = (scale - 1) * window.innerWidth / 2;
		const maxY = (scale - 1) * window.innerHeight / 2;
		return {
			x: Math.max(-maxX, Math.min(maxX, x)),
			y: Math.max(-maxY, Math.min(maxY, y))
		};
	}

	private startPinch(e: TouchEvent): void {
		const t1 = e.touches[0];
		const t2 = e.touches[1];
		this.pinchStartDist = this.getTouchDistance(t1, t2);
		this.pinchStartScale = this.zoomScale;
		const center = this.getTouchCenter(t1, t2);
		this.pinchStartCenterX = center.x;
		this.pinchStartCenterY = center.y;
		this.pinchStartZoomX = this.zoomX;
		this.pinchStartZoomY = this.zoomY;
		this.swipeType = 'pinch';
		this.swipeAxis = 'none';
	}

	private handleTouchCancel = (): void => {
		if (this.swipeType === 'nav') {
			this.callbacks.navPeekCancel();
		}
		this.swipeType = 'none';
		this.swipeAxis = 'none';
		if (this.isSwiping) {
			this.isSwiping = false;
			this.swipeAnimating = false;
			this.swipeProgress = 0;
			this.videoViewEl.style.transform = '';
		}
	};

	private handleTouchStart = (e: TouchEvent): void => {
		if (e.touches.length > 1) {
			// Cancel-and-switch: if no gesture committed yet, start pinch
			if (this.swipeAxis === 'none' && !this.swipeAnimating && !this.navAnimating && this.swipeType !== 'pinch') {
				this.startPinch(e);
			} else {
				this.lastMultiTouchTime = Date.now();
			}
			return;
		}
		if (this.swipeAnimating || this.navAnimating) return;
		if (this.swipeType === 'pinch') return;
		if (Date.now() - this.lastMultiTouchTime < this.MULTI_TOUCH_DEBOUNCE_MS) return;

		const touch = e.touches[0];
		this.swipeStartX = touch.clientX;
		this.swipeStartY = touch.clientY;
		this.swipeAxis = 'none';
		this.swipeType = 'none';
	};

	private handleTouchMove = (e: TouchEvent): void => {
		if (this.swipeAnimating || this.navAnimating) return;

		// Two-finger: pinch + pan
		if (e.touches.length > 1) {
			e.preventDefault();

			if (this.swipeType !== 'pinch') {
				// Cancel-and-switch: still in deadzone, switch to pinch
				if (this.swipeAxis === 'none') {
					this.startPinch(e);
				} else {
					// Already committed to single-finger gesture, ignore second finger
					this.lastMultiTouchTime = Date.now();
					return;
				}
			}

			const t1 = e.touches[0];
			const t2 = e.touches[1];
			const dist = this.getTouchDistance(t1, t2);
			const center = this.getTouchCenter(t1, t2);

			// Scale from pinch distance ratio
			const rawScale = this.pinchStartScale * (dist / this.pinchStartDist);
			const scale = Math.max(1, Math.min(this.MAX_ZOOM, rawScale));

			// Pan from center point delta
			const panDx = center.x - this.pinchStartCenterX;
			const panDy = center.y - this.pinchStartCenterY;
			const rawX = this.pinchStartZoomX + panDx;
			const rawY = this.pinchStartZoomY + panDy;
			const clamped = this.clampPan(rawX, rawY, scale);

			this.zoomScale = scale;
			this.zoomX = clamped.x;
			this.zoomY = clamped.y;
			this.callbacks.applyZoom(scale, clamped.x, clamped.y);
			return;
		}

		// Single finger — ignore during/right after pinch
		if (this.swipeType === 'pinch') return;
		if (Date.now() - this.lastMultiTouchTime < this.MULTI_TOUCH_DEBOUNCE_MS) return;

		const touch = e.touches[0];
		const dx = touch.clientX - this.swipeStartX;
		const dy = touch.clientY - this.swipeStartY;

		if (this.swipeAxis === 'none') {
			const deadzone = appDimensions.width * this.DEADZONE_RATIO;
			if (Math.abs(dx) < deadzone && Math.abs(dy) < deadzone) return;
			if (Math.abs(dx) >= Math.abs(dy)) {
				this.swipeAxis = 'horizontal';
				if (this.swipeStartX <= appDimensions.width * this.EDGE_ZONE_RATIO && dx > 0) {
					this.swipeType = 'edge-back';
					this.lockDx = dx;
					this.isSwiping = true;
				} else if (this.swipeStartY < window.innerHeight / 2) {
					this.swipeType = 'seek';
					this.seekBaseTime = this.callbacks.getSeekBase();
				} else {
					this.swipeType = 'ui';
				}
			} else {
				this.swipeAxis = 'vertical';
				this.swipeType = 'nav';
				// Reset zoom when starting nav — nav transforms conflict with zoom transforms
				if (this.zoomScale > 1) {
					this.resetZoom();
				}
			}
		}

		// preventDefault AFTER axis lock — don't block scroll before we know it's our gesture
		e.preventDefault();

		if (this.swipeType === 'edge-back') {
			const appWidth = appDimensions.width;
			const progress = Math.max(0, Math.min(1, (dx - this.lockDx) / (appWidth - this.lockDx)));
			this._swipeProgress = progress;
			this.videoViewEl.style.transform = `translateX(${progress * 100}%)`;
		} else if (this.swipeType === 'nav') {
			this.callbacks.navPeekUpdate(dy);
		} else if (this.swipeType === 'seek') {
			const seekDelta = (dx / appDimensions.width) * this.SEEK_RATE;
			const maxTime = this.callbacks.getSeekMaxTime();
			if (!isNaN(maxTime) && maxTime > 0) {
				const newTime = Math.max(0, Math.min(maxTime, this.seekBaseTime + seekDelta));
				this.callbacks.seekDirect(newTime);
			}
		}
	};

	private handleTouchEnd = (e: TouchEvent): void => {
		// Pinch end handling
		if (this.swipeType === 'pinch') {
			if (e.touches.length === 0) {
				// All fingers lifted — finalize
				this.swipeType = 'none';
				this.lastMultiTouchTime = Date.now();
				// Snap to 1x if barely zoomed
				if (this.zoomScale < 1.05) {
					this.resetZoom();
				}
			} else {
				// One finger remains — don't let it start a gesture
				this.swipeType = 'none';
				this.lastMultiTouchTime = Date.now();
			}
			return;
		}

		const touch = e.changedTouches[0];
		const dx = touch.clientX - this.swipeStartX;
		const dy = touch.clientY - this.swipeStartY;

		switch (this.swipeType) {
			case 'edge-back': {
				this.swipeAnimating = true;
				if (this._swipeProgress > this.EDGE_BACK_THRESHOLD) {
					this.swipeProgress = 1;
					setTimeout(() => {
						this.store.showList();
						this.isSwiping = false;
						this.swipeAnimating = false;
						this.swipeProgress = 0;
					}, 250);
				} else {
					this.swipeProgress = 0;
					setTimeout(() => {
						this.isSwiping = false;
						this.swipeAnimating = false;
					}, 250);
				}
				this.videoViewEl.style.transform = '';
				break;
			}
			case 'seek': {
				this.callbacks.seekFinish();
				break;
			}
			case 'nav': {
				this.navAnimating = true;
				this.callbacks.navPeekRelease(dy, () => {
					this.navAnimating = false;
				});
				break;
			}
			case 'ui': {
				if (Math.abs(dx) > this.UI_SWIPE_THRESHOLD) {
					this.store.isUiVisible = dx > 0;
				}
				break;
			}
		}
		this.swipeAxis = 'none';
		this.swipeType = 'none';
	};
}
