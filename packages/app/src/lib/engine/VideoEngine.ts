import Hls from 'hls.js';
import { STORAGE_KEYS, API, USE_NATIVE_HLS } from '../constants.js';
import { fetchAndParsePlaylist, clearPlaylistCache } from '../services/hls.js';
import type { Video } from '../types.js';

interface PlayerStore {
	view: 'list' | 'video';
	currentVideo: Video | null;
	currentVideoStartTime: number;
	activePlayerIndex: number;
	isUiVisible: boolean;
	swipeProgress: number;
	isSwiping: boolean;
	swipeAnimating: boolean;
	selectedProvider?: string;
	navigateVideo(video: Video, startTime: number, direction: 1 | -1, provider: string): void;
	showList(): void;
	setCurrentVideoLive(): void;
	setCurrentVideoNotLive(): void;
	onShowList(cb: () => void): void;
	onReload(cb: () => void): void;
	onProviderChange(cb: () => void): void;
}

interface VideoListStore {
	filteredVideos: Video[];
	selectedProvider: string;
	updateVideoLive(filename: string, isLive: boolean): void;
	removeVideo(filename: string): void;
}

export interface VideoEngineCallbacks {
	onTimeUpdate(currentTime: number, duration: number, seekableEnd: number): void;
	onMuteChange(isMuted: boolean): void;
	getPlayerStore(): PlayerStore;
	getVideoListStore(): VideoListStore;
}

export class VideoEngine {
	private elements: HTMLVideoElement[] = [];
	private videoViewEl!: HTMLElement;
	private videoContainer!: HTMLElement;
	private hlsInstances = new Map<HTMLVideoElement, Hls>();
	private nativeAbortControllers = new Map<HTMLVideoElement, AbortController>();
	private currentFilename: string | null = null;
	private wakeLock: WakeLockSentinel | null = null;
	private navCounter = 0;

	// Internal time tracking — updated 12x/sec, synced to Svelte at 4Hz
	private _currentTime = 0;
	private _duration = 0;
	private _seekableEnd = 0;
	private _lastTimeSync = 0;
	private readonly TIME_SYNC_MS = 250;

	// localStorage debounce — save every 3s instead of 12x/sec
	private _lastProgressSave = 0;
	private readonly PROGRESS_SAVE_MS = 3000;

	// Gesture state
	private swipeStartX = 0;
	private swipeStartY = 0;
	private swipeAxis: 'none' | 'horizontal' | 'vertical' = 'none';
	private swipeType: 'none' | 'edge-back' | 'seek' | 'nav' | 'ui' = 'none';
	private seekBaseTime = 0;
	private lastMultiTouchTime = 0;
	private _swipeProgress = 0;

	private readonly EDGE_ZONE = 30;
	private readonly EDGE_BACK_THRESHOLD = 0.3;
	private readonly FLICK_THRESHOLD = 80;
	private readonly UI_SWIPE_THRESHOLD = 80;
	private readonly SEEK_RATE = 60;
	private readonly MULTI_TOUCH_DEBOUNCE_MS = 100;

	constructor(private callbacks: VideoEngineCallbacks) {}

	init(videoViewEl: HTMLElement, videoContainer: HTMLElement): () => void {
		this.videoViewEl = videoViewEl;
		this.videoContainer = videoContainer;

		// Create 3 video elements
		const els: HTMLVideoElement[] = [];
		for (let i = 0; i < 3; i++) {
			const el = document.createElement('video');
			el.playsInline = true;
			el.preload = 'auto';
			el.muted = true;
			el.className = 'background-player';
			videoContainer.appendChild(el);
			els.push(el);
		}
		this.elements = els;

		// Attach timeupdate/volumechange listeners
		const timeHandlers = els.map((el) => this.makeTimeUpdateHandler(el));
		const volHandlers = els.map((el) => this.makeVolumeChangeHandler(el));
		els.forEach((el, i) => {
			el.addEventListener('timeupdate', timeHandlers[i]);
			el.addEventListener('volumechange', volHandlers[i]);
		});

		// Attach touch handlers
		const touchEl = videoViewEl;
		touchEl.addEventListener('touchstart', this.handleTouchStart);
		touchEl.addEventListener('touchmove', this.handleTouchMove, { passive: false });
		touchEl.addEventListener('touchend', this.handleTouchEnd);
		touchEl.addEventListener('touchcancel', this.handleTouchCancel);

		// Register store callbacks
		const store = this.callbacks.getPlayerStore();
		store.onShowList(() => {
			this.forceProgressSave();
			this.getActiveElement()?.pause();
		});

		store.onProviderChange(() => {
			this.elements.forEach((el) => this.clearStream(el));
			this.currentFilename = null;
		});

		store.onReload(() => {
			const cv = store.currentVideo;
			if (cv) this.forceReloadStream(this.getActiveElement(), cv);
		});

		return () => {
			els.forEach((el, i) => {
				el.removeEventListener('timeupdate', timeHandlers[i]);
				el.removeEventListener('volumechange', volHandlers[i]);
			});
			touchEl.removeEventListener('touchstart', this.handleTouchStart);
			touchEl.removeEventListener('touchmove', this.handleTouchMove);
			touchEl.removeEventListener('touchend', this.handleTouchEnd);
			touchEl.removeEventListener('touchcancel', this.handleTouchCancel);
		};
	}

	private makeTimeUpdateHandler(el: HTMLVideoElement): () => void {
		return () => {
			if (el !== this.getActiveElement()) return;
			this._currentTime = el.currentTime;
			this._duration = el.duration;
			if (el.duration === Infinity && el.seekable.length > 0) {
				this._seekableEnd = el.seekable.end(el.seekable.length - 1);
			}

			const now = performance.now();

			// Debounced localStorage save
			const cv = this.callbacks.getPlayerStore().currentVideo;
			if (cv && !cv.isLive && now - this._lastProgressSave >= this.PROGRESS_SAVE_MS) {
				this._lastProgressSave = now;
				localStorage.setItem(
					STORAGE_KEYS.PROGRESS_PREFIX + cv.filename,
					String(Math.round(el.currentTime))
				);
			}

			// Throttled sync to Svelte $state
			if (now - this._lastTimeSync >= this.TIME_SYNC_MS) {
				this._lastTimeSync = now;
				this.callbacks.onTimeUpdate(this._currentTime, this._duration, this._seekableEnd);
			}
		};
	}

	private makeVolumeChangeHandler(el: HTMLVideoElement): () => void {
		return () => {
			if (el !== this.getActiveElement()) return;
			this.callbacks.onMuteChange(el.muted);
		};
	}

	forceTimeSync(): void {
		this._lastTimeSync = performance.now();
		this.callbacks.onTimeUpdate(this._currentTime, this._duration, this._seekableEnd);
	}

	forceProgressSave(): void {
		const cv = this.callbacks.getPlayerStore().currentVideo;
		if (!cv || cv.isLive) return;
		const el = this.getActiveElement();
		if (!el || isNaN(el.currentTime)) return;
		localStorage.setItem(
			STORAGE_KEYS.PROGRESS_PREFIX + cv.filename,
			String(Math.round(el.currentTime))
		);
		this._lastProgressSave = performance.now();
	}

	private getActiveElement(): HTMLVideoElement {
		return this.elements[this.callbacks.getPlayerStore().activePlayerIndex];
	}

	// --- HLS Management ---

	private async activatePlayer(
		el: HTMLVideoElement,
		v: Video,
		startTime: number,
		thisNav?: number
	): Promise<void> {
		await this.loadStream(el, v, startTime, true);
		if (thisNav !== undefined && this.navCounter !== thisNav) return;

		try {
			await el.play();
		} catch (_e) {
			// autoplay may be blocked
		}
		el.style.opacity = '1';
	}

	private resolveStreamUrl(filename: string): string {
		return API.HLS_PLAYLIST(filename);
	}

	private syncLiveStatus(el: HTMLVideoElement, v: Video, isActivePlayer: boolean): void {
		if (!isActivePlayer) return;
		const store = this.callbacks.getPlayerStore();
		const listStore = this.callbacks.getVideoListStore();
		const isLive = el.duration === Infinity;
		if (isLive) {
			store.setCurrentVideoLive();
			listStore.updateVideoLive(v.filename, true);
		} else if (v.isLive) {
			store.setCurrentVideoNotLive();
			listStore.updateVideoLive(v.filename, false);
			clearPlaylistCache(v.filename);
		}
	}

	private setupHlsJs(
		el: HTMLVideoElement,
		url: string,
		v: Video,
		startTime: number,
		isActivePlayer: boolean,
		resolve: () => void
	): void {
		const oldHls = this.hlsInstances.get(el);
		if (oldHls) {
			oldHls.destroy();
			this.hlsInstances.delete(el);
		}

		const hls = new Hls();
		this.hlsInstances.set(el, hls);

		hls.on(Hls.Events.MANIFEST_PARSED, () => {
			resolve();
		});

		let initialLoadDone = false;
		let wasLive = false;
		const store = this.callbacks.getPlayerStore();
		const listStore = this.callbacks.getVideoListStore();

		hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
			const isLive = data.details.live;

			if (!initialLoadDone) {
				initialLoadDone = true;
				if (isLive) {
					wasLive = true;
					if (isActivePlayer) {
						store.setCurrentVideoLive();
						listStore.updateVideoLive(v.filename, true);
					}
				} else if (startTime > 0) {
					el.currentTime = startTime;
				}
				return;
			}

			if (wasLive && !isLive) {
				wasLive = false;
				if (isActivePlayer) {
					store.setCurrentVideoNotLive();
					listStore.updateVideoLive(v.filename, false);
					clearPlaylistCache(v.filename);
				}
			}
		});

		hls.on(Hls.Events.ERROR, (_event, data) => {
			if (data.fatal) {
				if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
					if (data.response?.code === 404) {
						listStore.removeVideo(v.filename);
						this.handleVideoGone();
						return;
					}
					hls.startLoad();
				} else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
					hls.recoverMediaError();
				}
			}
		});

		hls.loadSource(url);
		hls.attachMedia(el);
	}

	private setupNativeHls(
		el: HTMLVideoElement,
		url: string,
		v: Video,
		startTime: number,
		isActivePlayer: boolean,
		resolve: () => void
	): void {
		const oldController = this.nativeAbortControllers.get(el);
		if (oldController) oldController.abort();
		const controller = new AbortController();
		this.nativeAbortControllers.set(el, controller);
		const signal = controller.signal;

		const store = this.callbacks.getPlayerStore();
		const listStore = this.callbacks.getVideoListStore();

		let nativeWasLive = false;
		const onReady = () => {
			if (el.duration === Infinity) {
				nativeWasLive = true;
				if (isActivePlayer) {
					store.setCurrentVideoLive();
					listStore.updateVideoLive(v.filename, true);
				}
			} else if (startTime > 0) {
				el.currentTime = startTime;
			}
			resolve();
		};
		const onDurationChange = () => {
			if (nativeWasLive && el.duration !== Infinity) {
				nativeWasLive = false;
				if (isActivePlayer) {
					store.setCurrentVideoNotLive();
					listStore.updateVideoLive(v.filename, false);
					clearPlaylistCache(v.filename);
				}
			}
		};
		const onError = () => {
			const mediaError = el.error;
			if (mediaError) {
				console.warn('Native HLS error', mediaError.code, mediaError.message);
				if (!isActivePlayer) return;
				listStore.removeVideo(v.filename);
				this.handleVideoGone();
			}
		};
		el.addEventListener('loadedmetadata', onReady, { once: true, signal });
		el.addEventListener('durationchange', onDurationChange, { signal });
		el.addEventListener('error', onError, { signal });
		el.src = url;
	}

	private loadStream(
		el: HTMLVideoElement,
		v: Video,
		startTime: number,
		isActivePlayer = false
	): Promise<void> {
		return new Promise((resolve) => {
			const hasActiveStream = this.hlsInstances.has(el) || this.nativeAbortControllers.has(el);
			const streamAlive =
				el.dataset.loadedFilename === v.filename && hasActiveStream && !!el.src;
			if (streamAlive) {
				this.syncLiveStatus(el, v, isActivePlayer);
				if (startTime > 0) el.currentTime = startTime;
				resolve();
				return;
			}
			if (el.dataset.loadedFilename === v.filename) {
				delete el.dataset.loadedFilename;
			}

			const url = this.resolveStreamUrl(v.filename);

			if (!USE_NATIVE_HLS && Hls.isSupported()) {
				this.setupHlsJs(el, url, v, startTime, isActivePlayer, resolve);
			} else {
				this.setupNativeHls(el, url, v, startTime, isActivePlayer, resolve);
			}

			el.dataset.loadedFilename = v.filename;
		});
	}

	private forceReloadStream(el: HTMLVideoElement, v: Video): void {
		delete el.dataset.loadedFilename;
		void this.activatePlayer(el, v, 0);
	}

	private clearStream(el: HTMLVideoElement): void {
		el.pause();
		el.style.opacity = '';

		const hls = this.hlsInstances.get(el);
		if (hls) {
			hls.destroy();
			this.hlsInstances.delete(el);
		}

		const controller = this.nativeAbortControllers.get(el);
		if (controller) {
			controller.abort();
			this.nativeAbortControllers.delete(el);
		}

		el.removeAttribute('src');
		if (el.dataset.loadedFilename) {
			el.load();
		}
		delete el.dataset.loadedFilename;
	}

	// --- Navigation ---

	handleVideoGone(): void {
		const listStore = this.callbacks.getVideoListStore();
		const filteredList = listStore.filteredVideos;
		const next = this.findAdjacentVideo(1);
		if (next) {
			const saved = this.getSavedTime(next);
			this.callbacks
				.getPlayerStore()
				.navigateVideo(next, saved, 1, listStore.selectedProvider);
		} else if (filteredList.length > 0) {
			const first = filteredList[0];
			const saved = this.getSavedTime(first);
			this.callbacks
				.getPlayerStore()
				.navigateVideo(first, saved, 1, listStore.selectedProvider);
		} else {
			this.callbacks.getPlayerStore().showList();
		}
	}

	private findAdjacentVideo(direction: 1 | -1): Video | null {
		const store = this.callbacks.getPlayerStore();
		const cv = store.currentVideo;
		if (!cv) return null;
		const filteredList = this.callbacks.getVideoListStore().filteredVideos;
		if (filteredList.length < 2) return null;
		const idx = filteredList.findIndex(
			(v) => v.filename === cv.filename && v.type === cv.type
		);
		if (idx === -1) return null;
		for (let i = idx + direction; i >= 0 && i < filteredList.length; i += direction) {
			if (filteredList[i].filename !== cv.filename) return filteredList[i];
		}
		return null;
	}

	private navigateToVideo(target: Video, dir: 1 | -1): void {
		const saved = this.getSavedTime(target);
		const listStore = this.callbacks.getVideoListStore();
		this.forceProgressSave();
		this.callbacks.getPlayerStore().navigateVideo(target, saved, dir, listStore.selectedProvider);
		void fetchAndParsePlaylist(target);
	}

	private getSavedTime(v: Video): number {
		return parseFloat(localStorage.getItem(STORAGE_KEYS.PROGRESS_PREFIX + v.filename) || '0');
	}

	// --- Public methods for $effects ---

	activateIfChanged(cv: Video, activeIdx: number, startTime: number): void {
		if (this.elements.length === 0) return;

		const videoChanged = this.currentFilename !== cv.filename;
		this.currentFilename = cv.filename;

		this.elements.forEach((el, i) => {
			if (i === activeIdx) {
				if (videoChanged) el.style.opacity = '0';
				el.className = 'active-player';
			} else {
				el.style.opacity = '';
				el.className = 'background-player';
				el.muted = true;
			}
		});

		const activeEl = this.elements[activeIdx];
		this.callbacks.onMuteChange(activeEl.muted);

		if (videoChanged) {
			const thisNav = ++this.navCounter;
			void this.activatePlayer(activeEl, cv, startTime, thisNav);
		} else if (activeEl.paused) {
			void activeEl.play();
		}
	}

	preloadForVideo(cv: Video, activeIdx: number, filteredList: Video[]): void {
		if (this.elements.length === 0) return;

		const idx = filteredList.findIndex(
			(v) => v.filename === cv.filename && v.type === cv.type
		);
		if (idx === -1) return;

		const nextVideo = idx < filteredList.length - 1 ? filteredList[idx + 1] : null;
		const prevVideo = idx > 0 ? filteredList[idx - 1] : null;

		const nextPlayer = this.elements[(activeIdx + 1) % 3];
		if (nextVideo) {
			void this.preloadAndPlay(nextPlayer, nextVideo);
		} else {
			this.clearStream(nextPlayer);
		}

		const prevPlayer = this.elements[(activeIdx + 2) % 3];
		if (prevVideo) {
			void this.preloadAndPause(prevPlayer, prevVideo);
		} else {
			this.clearStream(prevPlayer);
		}
	}

	private async preloadAndPlay(el: HTMLVideoElement, v: Video): Promise<void> {
		const startTime = this.getSavedTime(v);
		await this.loadStream(el, v, startTime);
		el.muted = true;
		try {
			if (el.paused) await el.play();
		} catch (e) {
			console.warn('Autoplay muted failed', e);
		}
	}

	private async preloadAndPause(el: HTMLVideoElement, v: Video): Promise<void> {
		const startTime = this.getSavedTime(v);
		await this.loadStream(el, v, startTime);
		if (!el.paused) el.pause();
	}

	// --- Wake Lock ---

	async updateWakeLock(shouldBeActive: boolean): Promise<void> {
		if (shouldBeActive && !this.wakeLock) {
			if ('wakeLock' in navigator) {
				try {
					this.wakeLock = await navigator.wakeLock.request('screen');
				} catch (e) {
					console.warn('Wake lock failed', e);
				}
			}
		} else if (!shouldBeActive && this.wakeLock) {
			await this.wakeLock.release();
			this.wakeLock = null;
		}
	}

	// --- Seek & Mute ---

	handleSeek(time: number): void {
		const activeEl = this.getActiveElement();
		if (!isNaN(activeEl.duration)) {
			const wasPlaying = !activeEl.paused;
			if (wasPlaying) activeEl.pause();
			activeEl.currentTime = time;
			this._currentTime = time;
			this.forceTimeSync();
			if (wasPlaying) {
				activeEl.addEventListener('seeked', () => void activeEl.play(), { once: true });
			}
		}
	}

	toggleMute(): void {
		const activeEl = this.getActiveElement();
		activeEl.muted = !activeEl.muted;
	}

	// --- Gesture Handlers ---

	private handleTouchCancel = (): void => {
		this.swipeType = 'none';
		this.swipeAxis = 'none';
		const store = this.callbacks.getPlayerStore();
		if (store.isSwiping) {
			store.isSwiping = false;
			store.swipeAnimating = false;
			store.swipeProgress = 0;
			this.videoViewEl.style.transform = '';
		}
	};

	private handleTouchStart = (e: TouchEvent): void => {
		if (e.touches.length > 1) {
			this.lastMultiTouchTime = Date.now();
			return;
		}
		const store = this.callbacks.getPlayerStore();
		if (store.swipeAnimating) return;
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
		const store = this.callbacks.getPlayerStore();
		if (store.swipeAnimating) return;
		if (Date.now() - this.lastMultiTouchTime < this.MULTI_TOUCH_DEBOUNCE_MS) return;
		e.preventDefault();

		const touch = e.touches[0];
		const dx = touch.clientX - this.swipeStartX;
		const dy = touch.clientY - this.swipeStartY;

		if (this.swipeAxis === 'none') {
			if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
			if (Math.abs(dx) >= Math.abs(dy)) {
				this.swipeAxis = 'horizontal';
				if (this.swipeStartX <= this.EDGE_ZONE && dx > 0) {
					this.swipeType = 'edge-back';
					store.isSwiping = true;
				} else if (this.swipeStartY < window.innerHeight / 2) {
					this.swipeType = 'seek';
					this.seekBaseTime = this.getActiveElement().currentTime;
				} else {
					this.swipeType = 'ui';
				}
			} else {
				this.swipeAxis = 'vertical';
				this.swipeType = 'nav';
			}
		}

		if (this.swipeType === 'edge-back') {
			const progress = Math.max(0, Math.min(1, dx / window.innerWidth));
			this._swipeProgress = progress;
			// Direct DOM — no $state write during drag
			this.videoViewEl.style.transform = `translateX(${progress * 100}%)`;
		} else if (this.swipeType === 'seek') {
			const seekDelta = (dx / window.innerWidth) * this.SEEK_RATE;
			const activeEl = this.getActiveElement();
			const maxTime =
				activeEl.duration === Infinity ? this._seekableEnd : activeEl.duration;
			if (!isNaN(maxTime) && maxTime > 0) {
				const newTime = Math.max(0, Math.min(maxTime, this.seekBaseTime + seekDelta));
				activeEl.currentTime = newTime;
				this._currentTime = newTime;
				this.forceTimeSync();
			}
		}
	};

	private handleTouchEnd = (e: TouchEvent): void => {
		const touch = e.changedTouches[0];
		const dx = touch.clientX - this.swipeStartX;
		const dy = touch.clientY - this.swipeStartY;
		const store = this.callbacks.getPlayerStore();

		switch (this.swipeType) {
			case 'edge-back': {
				store.swipeAnimating = true;
				// Hand off to Svelte for CSS transition
				if (this._swipeProgress > this.EDGE_BACK_THRESHOLD) {
					store.swipeProgress = 1;
					setTimeout(() => {
						store.showList();
						store.isSwiping = false;
						store.swipeAnimating = false;
						store.swipeProgress = 0;
					}, 250);
				} else {
					store.swipeProgress = 0;
					setTimeout(() => {
						store.isSwiping = false;
						store.swipeAnimating = false;
					}, 250);
				}
				// Clear direct DOM transform — Svelte's style binding takes over
				this.videoViewEl.style.transform = '';
				break;
			}
			case 'nav': {
				if (Math.abs(dy) > this.FLICK_THRESHOLD) {
					const dir = dy < 0 ? 1 : -1;
					const target = this.findAdjacentVideo(dir as 1 | -1);
					if (target) {
						this.navigateToVideo(target, dir as 1 | -1);
					}
				}
				break;
			}
			case 'ui': {
				if (Math.abs(dx) > this.UI_SWIPE_THRESHOLD) {
					store.isUiVisible = dx > 0;
				}
				break;
			}
		}
		this.swipeAxis = 'none';
		this.swipeType = 'none';
	};
}
