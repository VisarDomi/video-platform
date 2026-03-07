import Hls from 'hls.js';
import { STORAGE_KEYS, API, USE_NATIVE_HLS } from '../constants.js';
import { clearPlaylistCache } from '../services/hls.js';
import { getSavedTime } from '../utils/navigation.js';
import type { Video } from '../types.js';

export interface VideoEngineCallbacks {
	onTimeUpdate(currentTime: number, duration: number, seekableEnd: number): void;
	onMuteChange(isMuted: boolean): void;
	onLiveStatusChanged(filename: string, isLive: boolean): void;
	onVideoRemoved(filename: string): void;
}

export class VideoEngine {
	private elements: HTMLVideoElement[] = [];
	private videoContainer!: HTMLElement;
	private hlsInstances = new Map<HTMLVideoElement, Hls>();
	private nativeAbortControllers = new Map<HTMLVideoElement, AbortController>();
	private currentFilename: string | null = null;
	private wakeLock: WakeLockSentinel | null = null;
	private navCounter = 0;

	private activePlayerIndex = 0;
	private currentIsLive = false;

	// Internal time tracking — updated 12x/sec, synced to Svelte at 4Hz
	private _currentTime = 0;
	private _duration = 0;
	private _seekableEnd = 0;
	private _lastTimeSync = 0;
	private readonly TIME_SYNC_MS = 250;

	// localStorage debounce — save every 3s instead of 12x/sec
	private _lastProgressSave = 0;
	private readonly PROGRESS_SAVE_MS = 3000;

	constructor(private callbacks: VideoEngineCallbacks) {}

	init(videoContainer: HTMLElement): () => void {
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

		return () => {
			els.forEach((el, i) => {
				el.removeEventListener('timeupdate', timeHandlers[i]);
				el.removeEventListener('volumechange', volHandlers[i]);
			});
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
			if (
				this.currentFilename &&
				!this.currentIsLive &&
				now - this._lastProgressSave >= this.PROGRESS_SAVE_MS
			) {
				this._lastProgressSave = now;
				localStorage.setItem(
					STORAGE_KEYS.PROGRESS_PREFIX + this.currentFilename,
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
		if (!this.currentFilename || this.currentIsLive) return;
		const el = this.getActiveElement();
		if (!el || isNaN(el.currentTime)) return;
		localStorage.setItem(
			STORAGE_KEYS.PROGRESS_PREFIX + this.currentFilename,
			String(Math.round(el.currentTime))
		);
		this._lastProgressSave = performance.now();
	}

	private getActiveElement(): HTMLVideoElement {
		return this.elements[this.activePlayerIndex];
	}

	// --- Lifecycle methods (called by component) ---

	onViewHidden(): void {
		this.forceProgressSave();
		this.getActiveElement()?.pause();
	}

	onProviderChange(): void {
		this.elements.forEach((el) => this.clearStream(el));
		this.currentFilename = null;
	}

	forceReloadStream(video: Video): void {
		const el = this.getActiveElement();
		delete el.dataset.loadedFilename;
		void this.activatePlayer(el, video, 0);
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
		const isLive = el.duration === Infinity;
		if (isLive) {
			this.currentIsLive = true;
			this.callbacks.onLiveStatusChanged(v.filename, true);
		} else if (v.isLive) {
			this.currentIsLive = false;
			this.callbacks.onLiveStatusChanged(v.filename, false);
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

		hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
			const isLive = data.details.live;

			if (!initialLoadDone) {
				initialLoadDone = true;
				if (isLive) {
					wasLive = true;
					if (isActivePlayer) {
						this.currentIsLive = true;
						this.callbacks.onLiveStatusChanged(v.filename, true);
					}
				} else if (startTime > 0) {
					el.currentTime = startTime;
				}
				return;
			}

			if (wasLive && !isLive) {
				wasLive = false;
				if (isActivePlayer) {
					this.currentIsLive = false;
					this.callbacks.onLiveStatusChanged(v.filename, false);
					clearPlaylistCache(v.filename);
				}
			}
		});

		hls.on(Hls.Events.ERROR, (_event, data) => {
			if (data.fatal) {
				if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
					if (data.response?.code === 404) {
						this.callbacks.onVideoRemoved(v.filename);
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

		let nativeWasLive = false;
		const onReady = () => {
			if (el.duration === Infinity) {
				nativeWasLive = true;
				if (isActivePlayer) {
					this.currentIsLive = true;
					this.callbacks.onLiveStatusChanged(v.filename, true);
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
					this.currentIsLive = false;
					this.callbacks.onLiveStatusChanged(v.filename, false);
					clearPlaylistCache(v.filename);
				}
			}
		};
		const onError = () => {
			const mediaError = el.error;
			if (mediaError) {
				console.warn('Native HLS error', mediaError.code, mediaError.message);
				if (!isActivePlayer) return;
				this.callbacks.onVideoRemoved(v.filename);
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

	// --- Public methods for $effects ---

	activateIfChanged(cv: Video, activeIdx: number, startTime: number): void {
		if (this.elements.length === 0) return;

		const videoChanged = this.currentFilename !== cv.filename;
		this.currentFilename = cv.filename;
		this.activePlayerIndex = activeIdx;
		this.currentIsLive = cv.isLive ?? false;

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
		const startTime = getSavedTime(v);
		await this.loadStream(el, v, startTime);
		el.muted = true;
		try {
			if (el.paused) await el.play();
		} catch (e) {
			console.warn('Autoplay muted failed', e);
		}
	}

	private async preloadAndPause(el: HTMLVideoElement, v: Video): Promise<void> {
		const startTime = getSavedTime(v);
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

	seekDirect(time: number): void {
		const activeEl = this.getActiveElement();
		if (!isNaN(activeEl.duration)) {
			activeEl.currentTime = time;
			this._currentTime = time;
		}
	}

	getCurrentTime(): number {
		return this._currentTime;
	}

	getDuration(): number {
		return this._duration;
	}

	getSeekableEnd(): number {
		return this._seekableEnd;
	}

	toggleMute(): void {
		const activeEl = this.getActiveElement();
		activeEl.muted = !activeEl.muted;
	}
}
