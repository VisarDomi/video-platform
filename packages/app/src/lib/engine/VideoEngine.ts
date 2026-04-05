import Hls from 'hls.js';
import { STORAGE_KEYS, API, USE_NATIVE_HLS } from '../constants.js';
import { getSavedTime } from '../utils/navigation.js';
import type { Video } from '../types.js';
import type { LogEmit } from '../services/LogService.js';
import type { PlayerOverlayState } from './PlayerOverlayState.svelte.js';

export interface VideoEngineCallbacks {
	onLiveStatusChanged(filename: string, isLive: boolean): void;
	onVideoRemoved(filename: string): void;
}

interface PlayerUnit {
	wrapper: HTMLElement;
	video: HTMLVideoElement;
	state: PlayerOverlayState;
}

export class VideoEngine {
	private units: PlayerUnit[] = [];
	private videoContainer!: HTMLElement;
	private hlsInstances = new Map<HTMLVideoElement, Hls>();
	private nativeAbortControllers = new Map<HTMLVideoElement, AbortController>();
	private wakeLock: WakeLockSentinel | null = null;
	private navCounter = 0;

	private activePlayerIndex = 0;
	private currentIsLive = false;

	private _currentTime = 0;
	private _duration = 0;
	private _seekableEnd = 0;
	private _lastTimeSync = 0;
	private readonly TIME_SYNC_MS = 250;

	private _lastProgressSave = 0;
	private readonly PROGRESS_SAVE_MS = 3000;

	private emit: LogEmit;

	constructor(private callbacks: VideoEngineCallbacks, emit: LogEmit) {
		this.emit = emit;
	}

	init(videoContainer: HTMLElement, overlayStates: PlayerOverlayState[]): () => void {
		this.videoContainer = videoContainer;

		for (let i = 0; i < 3; i++) {
			const wrapper = document.createElement('div');
			wrapper.className = 'player-unit background-unit';

			const video = document.createElement('video');
			video.playsInline = true;
			video.preload = 'auto';
			video.muted = true;

			wrapper.appendChild(video);
			videoContainer.appendChild(wrapper);

			this.units.push({ wrapper, video, state: overlayStates[i] });
		}

		const timeHandlers = this.units.map((u) => this.makeTimeUpdateHandler(u));
		const volHandlers = this.units.map((u) => this.makeVolumeChangeHandler(u));
		this.units.forEach((u, i) => {
			u.video.addEventListener('timeupdate', timeHandlers[i]);
			u.video.addEventListener('volumechange', volHandlers[i]);
		});

		return () => {
			this.units.forEach((u, i) => {
				u.video.removeEventListener('timeupdate', timeHandlers[i]);
				u.video.removeEventListener('volumechange', volHandlers[i]);
			});
		};
	}

	getUnitWrapper(index: number): HTMLElement {
		return this.units[index].wrapper;
	}

	private makeTimeUpdateHandler(unit: PlayerUnit): () => void {
		let lastSync = 0;
		return () => {
			const el = unit.video;
			const ct = el.currentTime;
			const dur = el.duration;
			let se = unit.state.seekableEnd;
			if (dur === Infinity && el.seekable.length > 0) {
				se = el.seekable.end(el.seekable.length - 1);
			}

			const now = performance.now();
			const isActive = el === this.getActiveElement();

			if (isActive) {
				this._currentTime = ct;
				this._duration = dur;
				this._seekableEnd = se;

				const activeFilename = el.dataset.loadedFilename;
				if (
					activeFilename &&
					!this.currentIsLive &&
					now - this._lastProgressSave >= this.PROGRESS_SAVE_MS
				) {
					this._lastProgressSave = now;
					localStorage.setItem(
						STORAGE_KEYS.PROGRESS_PREFIX + activeFilename,
						String(Math.round(ct))
					);
				}
			}

			if (now - lastSync >= this.TIME_SYNC_MS) {
				lastSync = now;
				unit.state.currentTime = ct;
				unit.state.duration = dur;
				unit.state.seekableEnd = se;
			}
		};
	}

	private makeVolumeChangeHandler(unit: PlayerUnit): () => void {
		return () => {
			unit.state.isMuted = unit.video.muted;
		};
	}

	forceTimeSync(): void {
		this._lastTimeSync = performance.now();
		const unit = this.getActiveUnit();
		unit.state.currentTime = this._currentTime;
		unit.state.duration = this._duration;
		unit.state.seekableEnd = this._seekableEnd;
	}

	forceProgressSave(): void {
		const el = this.getActiveElement();
		const activeFilename = el?.dataset.loadedFilename;
		if (!activeFilename || this.currentIsLive) return;
		if (!el || isNaN(el.currentTime)) return;
		localStorage.setItem(
			STORAGE_KEYS.PROGRESS_PREFIX + activeFilename,
			String(Math.round(el.currentTime))
		);
		this._lastProgressSave = performance.now();
	}

	private getActiveElement(): HTMLVideoElement {
		return this.units[this.activePlayerIndex].video;
	}

	private getActiveUnit(): PlayerUnit {
		return this.units[this.activePlayerIndex];
	}

	onViewHidden(): void {
		this.forceProgressSave();
		this.getActiveElement()?.pause();
	}

	onProviderChange(): void {
		this.units.forEach((u) => this.clearStream(u));
	}

	forceReloadStream(video: Video): void {
		const unit = this.getActiveUnit();
		delete unit.video.dataset.loadedFilename;
		void this.activatePlayer(unit, video, 0);
	}

	private async activatePlayer(
		unit: PlayerUnit,
		v: Video,
		startTime: number,
		thisNav?: number
	): Promise<void> {
		await this.loadStream(unit, v, startTime, true);
		if (thisNav !== undefined && this.navCounter !== thisNav) return;

		try {
			await unit.video.play();
		} catch (_e) {
		}
		unit.wrapper.style.opacity = '1';
	}

	private resolveStreamUrl(v: Video): string {
		return API.HLS_PLAYLIST(v.provider, v.filename);
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
		unit: PlayerUnit,
		v: Video,
		startTime: number,
		isActivePlayer = false
	): Promise<void> {
		const el = unit.video;
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

			const url = this.resolveStreamUrl(v);

			if (!USE_NATIVE_HLS && Hls.isSupported()) {
				this.setupHlsJs(el, url, v, startTime, isActivePlayer, resolve);
			} else {
				this.setupNativeHls(el, url, v, startTime, isActivePlayer, resolve);
			}

			el.dataset.loadedFilename = v.filename;
			unit.state.loadedFilename = v.filename;
			unit.state.currentTime = 0;
			unit.state.duration = 0;
			unit.state.seekableEnd = 0;
			const slot = this.units.indexOf(unit);
			this.emit('unit-load', { slot, filename: v.filename, provider: v.provider });
		});
	}

	private clearStream(unit: PlayerUnit): void {
		const el = unit.video;
		el.pause();
		unit.wrapper.style.opacity = '';

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
		unit.state.loadedFilename = null;
		unit.state.currentTime = 0;
		unit.state.duration = 0;
		unit.state.seekableEnd = 0;
	}

	activateIfChanged(cv: Video, activeIdx: number, startTimeOverride: number | null): void {
		if (this.units.length === 0) return;

		const activeUnit = this.units[activeIdx];
		const slotFilename = activeUnit.video.dataset.loadedFilename;
		const videoChanged = slotFilename !== cv.filename;
		this.activePlayerIndex = activeIdx;
		this.currentIsLive = cv.isLive ?? false;

		this.units.forEach((u, i) => {
			u.wrapper.style.transform = '';
			u.wrapper.style.transition = '';
			u.state.isActive = i === activeIdx;
			if (i === activeIdx) {
				if (videoChanged) u.wrapper.style.opacity = '0';
				u.wrapper.className = 'player-unit active-unit';
			} else {
				u.wrapper.style.opacity = '';
				u.wrapper.className = 'player-unit background-unit';
				u.video.muted = true;
			}
		});

		this.emit('unit-activate', { slot: activeIdx, filename: cv.filename, videoChanged });

		activeUnit.state.isMuted = activeUnit.video.muted;

		if (videoChanged) {
			const startTime = this.resolveStartTime(activeUnit.video, cv, startTimeOverride);
			const thisNav = ++this.navCounter;
			void this.activatePlayer(activeUnit, cv, startTime, thisNav);
		} else if (activeUnit.video.paused) {
			void activeUnit.video.play();
		}
	}

	private resolveStartTime(el: HTMLVideoElement, cv: Video, override: number | null): number {
		if (override !== null) return override;
		if (el.dataset.loadedFilename === cv.filename) return -1;
		return getSavedTime(cv);
	}

	preloadForVideo(cv: Video, activeIdx: number, filteredList: Video[]): void {
		if (this.units.length === 0) return;

		const idx = filteredList.findIndex(
			(v) => v.filename === cv.filename && v.type === cv.type
		);
		if (idx === -1) return;

		const nextVideo = idx < filteredList.length - 1 ? filteredList[idx + 1] : null;
		const prevVideo = idx > 0 ? filteredList[idx - 1] : null;

		const nextUnit = this.units[(activeIdx + 1) % 3];
		if (nextVideo) {
			void this.preloadAndPlay(nextUnit, nextVideo);
		} else {
			this.clearStream(nextUnit);
		}

		const prevUnit = this.units[(activeIdx + 2) % 3];
		if (prevVideo) {
			void this.preloadAndPause(prevUnit, prevVideo);
		} else {
			this.clearStream(prevUnit);
		}
	}

	private readonly NAV_COMMIT_THRESHOLD = 0.2;
	private readonly NAV_ANIM_MS = 250;

	navPeekUpdate(dy: number): void {
		if (this.units.length === 0) return;
		const vh = window.innerHeight;
		const activeUnit = this.getActiveUnit();

		activeUnit.wrapper.style.transform = `translateY(${dy}px)`;
		activeUnit.wrapper.style.transition = 'none';

		const nextIdx = (this.activePlayerIndex + 1) % 3;
		const prevIdx = (this.activePlayerIndex + 2) % 3;
		const nextUnit = this.units[nextIdx];
		const prevUnit = this.units[prevIdx];

		if (dy < 0) {
			if (nextUnit.video.dataset.loadedFilename) {
				nextUnit.wrapper.style.opacity = '1';
				nextUnit.wrapper.style.transform = `translateY(${dy + vh}px)`;
				nextUnit.wrapper.style.transition = 'none';
			}
			prevUnit.wrapper.style.opacity = '0';
			prevUnit.wrapper.style.transform = '';
		} else if (dy > 0) {
			if (prevUnit.video.dataset.loadedFilename) {
				prevUnit.wrapper.style.opacity = '1';
				prevUnit.wrapper.style.transform = `translateY(${dy - vh}px)`;
				prevUnit.wrapper.style.transition = 'none';
			}
			nextUnit.wrapper.style.opacity = '0';
			nextUnit.wrapper.style.transform = '';
		}
	}

	navPeekRelease(dy: number, onNavigate: (dir: 1 | -1) => void, onDone: () => void): void {
		if (this.units.length === 0) { onDone(); return; }

		const vh = window.innerHeight;
		const threshold = vh * this.NAV_COMMIT_THRESHOLD;
		const dir: 1 | -1 = dy < 0 ? 1 : -1;
		const peekIdx = dir === 1
			? (this.activePlayerIndex + 1) % 3
			: (this.activePlayerIndex + 2) % 3;
		const peekUnit = this.units[peekIdx];
		const hasPeek = !!peekUnit.video.dataset.loadedFilename;
		const activeUnit = this.getActiveUnit();

		if (Math.abs(dy) > threshold && hasPeek) {
			this.emit('peek-commit', { dir, peekFilename: peekUnit.video.dataset.loadedFilename ?? null });

			const transition = `transform ${this.NAV_ANIM_MS}ms ease-out`;
			activeUnit.wrapper.style.transition = transition;
			activeUnit.wrapper.style.transform = `translateY(${dir === 1 ? -vh : vh}px)`;

			peekUnit.wrapper.style.transition = transition;
			peekUnit.wrapper.style.transform = 'translateY(0)';

			setTimeout(() => {
				activeUnit.wrapper.style.opacity = '0';
				onNavigate(dir);
				onDone();
			}, this.NAV_ANIM_MS);
		} else {
			const transition = `transform ${this.NAV_ANIM_MS}ms ease-out`;
			activeUnit.wrapper.style.transition = transition;
			activeUnit.wrapper.style.transform = 'translateY(0)';

			if (hasPeek && Math.abs(dy) > 0) {
				peekUnit.wrapper.style.transition = `transform ${this.NAV_ANIM_MS}ms ease-out, opacity ${this.NAV_ANIM_MS}ms ease-out`;
				peekUnit.wrapper.style.transform = `translateY(${dir === 1 ? vh : -vh}px)`;
				peekUnit.wrapper.style.opacity = '0';
			}

			this.emit('peek-cancel');

			setTimeout(() => {
				this.clearPeekStyles();
				onDone();
			}, this.NAV_ANIM_MS);
		}
	}

	navPeekCancel(): void {
		this.clearPeekStyles();
	}

	private clearPeekStyles(): void {
		this.units.forEach((u, i) => {
			u.wrapper.style.transform = '';
			u.wrapper.style.transition = '';
			if (i !== this.activePlayerIndex) {
				u.wrapper.style.opacity = '';
			}
		});
	}

	private async preloadAndPlay(unit: PlayerUnit, v: Video): Promise<void> {
		const startTime = getSavedTime(v);
		await this.loadStream(unit, v, startTime);
		unit.video.muted = true;
		try {
			if (unit.video.paused) await unit.video.play();
		} catch (e) {
			console.warn('Autoplay muted failed', e);
		}
	}

	private async preloadAndPause(unit: PlayerUnit, v: Video): Promise<void> {
		const startTime = getSavedTime(v);
		await this.loadStream(unit, v, startTime);
		if (!unit.video.paused) unit.video.pause();
	}

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

	applyZoom(scale: number, x: number, y: number): void {
		const el = this.getActiveElement();
		if (!el) return;
		el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
	}

	resetZoom(): void {
		const el = this.getActiveElement();
		if (!el) return;
		el.style.transform = '';
	}

	handleSeek(time: number): void {
		const activeEl = this.getActiveElement();
		if (!isNaN(activeEl.duration)) {
			activeEl.pause();
			activeEl.currentTime = time;
			this._currentTime = time;
			this.forceTimeSync();
			activeEl.addEventListener('seeked', () => void activeEl.play(), { once: true });
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

	resume(): void {
		const el = this.getActiveElement();
		if (!el || !el.dataset.loadedFilename) return;

		const hls = this.hlsInstances.get(el);
		if (hls) {
			hls.startLoad();
		} else if (el.src) {
			const currentTime = el.currentTime;
			const wasLive = this.currentIsLive;
			el.load();
			el.addEventListener(
				'loadedmetadata',
				() => {
					if (!wasLive && currentTime > 0) {
						el.currentTime = currentTime;
					}
				},
				{ once: true }
			);
		}

		void el.play().catch(() => {});
	}
}
