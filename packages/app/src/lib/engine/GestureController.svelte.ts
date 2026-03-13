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
}

export class GestureController {
	private videoViewEl!: HTMLElement;

	private swipeStartX = 0;
	private swipeStartY = 0;
	private swipeAxis: 'none' | 'horizontal' | 'vertical' = 'none';
	private swipeType: 'none' | 'edge-back' | 'seek' | 'nav' | 'ui' = 'none';
	private seekBaseTime = 0;
	private lastMultiTouchTime = 0;
	private _swipeProgress = 0;
	private navAnimating = false;
	private lockDx = 0;

	swipeProgress = $state(0);
	isSwiping = $state(false);
	swipeAnimating = $state(false);

	private readonly EDGE_ZONE_RATIO = 0.077;
	private readonly DEADZONE_RATIO = 0.026;
	private readonly EDGE_BACK_THRESHOLD = 0.3;
	private readonly UI_SWIPE_THRESHOLD = 80;
	private readonly SEEK_RATE = 60;
	private readonly MULTI_TOUCH_DEBOUNCE_MS = 100;

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
			this.lastMultiTouchTime = Date.now();
			return;
		}
		if (this.swipeAnimating || this.navAnimating) return;
		if (Date.now() - this.lastMultiTouchTime < this.MULTI_TOUCH_DEBOUNCE_MS) return;

		const touch = e.touches[0];
		this.swipeStartX = touch.clientX;
		this.swipeStartY = touch.clientY;
		this.swipeAxis = 'none';
		this.swipeType = 'none';
	};

	private handleTouchMove = (e: TouchEvent): void => {
		if (e.touches.length > 1) {
			this.lastMultiTouchTime = Date.now();
			return;
		}
		if (this.swipeAnimating || this.navAnimating) return;
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
