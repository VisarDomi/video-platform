import { appDimensions } from './app-dimensions';

export interface GestureCallbacks {
    onNext(): void;
    onPrevious(): void;
    onShowList(): void;
    onSetUiVisible(visible: boolean): void;
}

export interface PeekCallbacks {
    navPeekUpdate(dy: number): void;
    navPeekRelease(dy: number, onDone: () => void): void;
    navPeekCancel(): void;
}

export interface GestureElements {
    videoView: HTMLElement;
    listView: HTMLElement;
}

export class GestureController {
    private swipeStartX = 0;
    private swipeStartY = 0;
    private swipeAxis: 'none' | 'horizontal' | 'vertical' = 'none';
    private swipeType: 'none' | 'nav' | 'ui' | 'edge-back' = 'none';
    private swipeAnimating = false;
    private lockDx = 0;

    private static readonly FLICK_THRESHOLD = 80;
    private static readonly UI_SWIPE_THRESHOLD = 80;
    private static readonly EDGE_ZONE_RATIO = 0.077;
    private static readonly DEADZONE_RATIO = 0.013;
    private static readonly EDGE_BACK_THRESHOLD = 0.15;

    private callbacks: GestureCallbacks;
    private elements: GestureElements;
    private peekCallbacks?: PeekCallbacks;

    constructor(
        container: HTMLElement,
        callbacks: GestureCallbacks,
        elements: GestureElements,
        originalAddEventListener: typeof EventTarget.prototype.addEventListener,
        peekCallbacks?: PeekCallbacks
    ) {
        this.callbacks = callbacks;
        this.elements = elements;
        this.peekCallbacks = peekCallbacks;
        this._attachListeners(container, originalAddEventListener);
    }

    private _attachListeners(container: HTMLElement, listen: typeof EventTarget.prototype.addEventListener) {
        listen.call(container, 'touchstart', (e: TouchEvent) => {
            if (e.touches.length > 1) return;
            if (this.swipeAnimating) return;

            const touch = e.touches[0];
            this.swipeStartX = touch.clientX;
            this.swipeStartY = touch.clientY;
            this.swipeAxis = 'none';
            this.swipeType = 'none';
        });

        listen.call(container, 'touchmove', (e: TouchEvent) => {
            if (e.touches.length > 1) return;
            if (this.swipeAnimating) return;

            const touch = e.touches[0];
            const dx = touch.clientX - this.swipeStartX;
            const dy = touch.clientY - this.swipeStartY;

            if (this.swipeAxis === 'none') {
                const deadzone = appDimensions.width * GestureController.DEADZONE_RATIO;
                if (Math.abs(dx) < deadzone && Math.abs(dy) < deadzone) return;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    this.swipeAxis = 'horizontal';
                    const edgeZone = appDimensions.width * GestureController.EDGE_ZONE_RATIO;
                    if (this.swipeStartX <= edgeZone && dx > 0) {
                        this.swipeType = 'edge-back';
                        this.lockDx = dx;
                        this.elements.videoView.classList.add('swipe-active');
                    } else {
                        this.swipeType = 'ui';
                    }
                } else {
                    this.swipeAxis = 'vertical';
                    this.swipeType = 'nav';
                }
            }

            // Only prevent default after axis is determined and it's a gesture we own
            if (this.swipeType !== 'none') {
                e.preventDefault();
            }

            if (this.swipeType === 'edge-back') {
                const progress = Math.max(0, Math.min(1, (dx - this.lockDx) / (appDimensions.width - this.lockDx)));
                this.elements.videoView.style.transform = `translateX(${progress * 100}%)`;
            }

            if (this.swipeType === 'nav' && this.peekCallbacks) {
                this.peekCallbacks.navPeekUpdate(dy);
            }
        }, { passive: false });

        listen.call(container, 'touchend', (e: TouchEvent) => {
            const touch = e.changedTouches[0];
            const dx = touch.clientX - this.swipeStartX;
            const dy = touch.clientY - this.swipeStartY;

            switch (this.swipeType) {
                case 'edge-back': {
                    const videoView = this.elements.videoView;
                    const progress = Math.max(0, Math.min(1, (dx - this.lockDx) / (appDimensions.width - this.lockDx)));
                    this.swipeAnimating = true;
                    videoView.classList.add('swipe-animating');

                    if (progress > GestureController.EDGE_BACK_THRESHOLD) {
                        videoView.style.transform = 'translateX(100%)';
                        videoView.addEventListener('transitionend', () => {
                            videoView.style.transform = '';
                            videoView.classList.remove('swipe-active', 'swipe-animating');
                            this.swipeAnimating = false;
                            this.callbacks.onShowList();
                        }, { once: true });
                    } else {
                        videoView.style.transform = '';
                        videoView.addEventListener('transitionend', () => {
                            videoView.classList.remove('swipe-active', 'swipe-animating');
                            this.swipeAnimating = false;
                        }, { once: true });
                    }
                    break;
                }
                case 'nav': {
                    if (this.peekCallbacks) {
                        this.swipeAnimating = true;
                        this.peekCallbacks.navPeekRelease(dy, () => {
                            this.swipeAnimating = false;
                        });
                    } else if (Math.abs(dy) > GestureController.FLICK_THRESHOLD) {
                        if (dy < 0) {
                            this.callbacks.onNext();
                        } else {
                            this.callbacks.onPrevious();
                        }
                    }
                    break;
                }
                case 'ui': {
                    if (Math.abs(dx) > GestureController.UI_SWIPE_THRESHOLD) {
                        this.callbacks.onSetUiVisible(dx > 0);
                    }
                    break;
                }
            }
            this.swipeAxis = 'none';
            this.swipeType = 'none';
        });

        listen.call(container, 'touchcancel', () => {
            if (this.swipeType === 'edge-back') {
                const videoView = this.elements.videoView;
                videoView.style.transform = '';
                videoView.classList.remove('swipe-active', 'swipe-animating');
            }
            if (this.swipeType === 'nav' && this.peekCallbacks) {
                this.peekCallbacks.navPeekCancel();
            }
            this.swipeType = 'none';
            this.swipeAxis = 'none';
            this.swipeAnimating = false;
        });
    }
}
