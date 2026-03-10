/**
 * ConnectionMonitor
 * Listens for visibility and connectivity changes at the browser/document level.
 * Includes iOS PWA fallbacks: pageshow (screen unlock) and focus (window regain).
 */
export class ConnectionMonitor {
	isOnline = $state(true);
	isVisible = $state(true);

	private cleanups: (() => void)[] = [];

	constructor(
		private onConnectivityChange?: (online: boolean) => void,
		private onVisibilityChange?: (visible: boolean) => void
	) {
		if (typeof document === 'undefined') return;

		this.isOnline = navigator.onLine;
		this.isVisible = document.visibilityState === 'visible';
		this.setupListeners();
	}

	private listen(target: EventTarget, event: string, handler: () => void) {
		target.addEventListener(event, handler);
		this.cleanups.push(() => target.removeEventListener(event, handler));
	}

	private setupListeners() {
		this.listen(window, 'online', () => {
			this.isOnline = true;
			this.onConnectivityChange?.(true);
		});

		this.listen(window, 'offline', () => {
			this.isOnline = false;
			this.onConnectivityChange?.(false);
		});

		this.listen(document, 'visibilitychange', () => {
			const visible = document.visibilityState === 'visible';
			this.isVisible = visible;
			this.onVisibilityChange?.(visible);
		});

		// iOS PWA: visibilitychange often doesn't fire on screen unlock
		this.listen(window, 'pageshow', () => {
			if (document.visibilityState === 'visible' && !this.isVisible) {
				this.isVisible = true;
				this.onVisibilityChange?.(true);
			}
		});

		this.listen(window, 'focus', () => {
			if (!this.isVisible) {
				this.isVisible = true;
				this.onVisibilityChange?.(true);
			}
		});
	}

	destroy() {
		for (const cleanup of this.cleanups) cleanup();
		this.cleanups = [];
	}
}
