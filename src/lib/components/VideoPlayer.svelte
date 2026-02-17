<script lang="ts">
	import Hls from 'hls.js';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { STORAGE_KEYS, API, USE_NATIVE_HLS } from '$lib/constants.js';
	import { untrack } from 'svelte';
	import { filterByAliases } from '$lib/utils/filter.js';
	import { fetchAndParsePlaylist, clearPlaylistCache } from '$lib/services/hls.js';

	import ProgressBar from './ProgressBar.svelte';
	import PlayerControls from './PlayerControls.svelte';
	import TlControls from './TlControls.svelte';
	import {
		startDownload,
		fetchMultiBroadcast,
		sendActiveSet,
		startProxy,
		getProxyUrl,
		syncProxySessions,
		blockStreamer
	} from '$lib/services/tl-api.js';
	import { VIDEO_TYPE } from '$lib/constants.js';
	import type { Video } from '$lib/types.js';

	let videoViewEl = $state<HTMLElement | null>(null);
	let videoElements = $state<HTMLVideoElement[]>([]);
	let videoContainer = $state<HTMLElement | null>(null);
	let currentTime = $state(0);
	let duration = $state(0);
	let seekableEnd = $state(0);
	let isMuted = $state(true);
	let currentFilename: string | null = null;
	let wakeLock: WakeLockSentinel | null = null;
	let navCounter = 0;

	const hlsInstances = new Map<HTMLVideoElement, Hls>();
	const nativeAbortControllers = new Map<HTMLVideoElement, AbortController>();

	const isVisible = $derived(playerStore.view === 'video');
	const video = $derived(playerStore.currentVideo);
	const isTl = $derived(videoListStore.selectedProvider === 'tl');
	const displayDuration = $derived(
		duration === Infinity && !isTl && seekableEnd > 0 ? seekableEnd : duration
	);


	// Initialize 3 video elements
	$effect(() => {
		if (!videoContainer || videoElements.length > 0) return;
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
		videoElements = els;
	});

	// Attach event listeners to video elements
	$effect(() => {
		if (videoElements.length === 0) return;

		const cleanups: (() => void)[] = [];

		videoElements.forEach((el) => {
			const onTimeUpdate = () => {
				if (el === getActiveElement()) {
					currentTime = el.currentTime;
					duration = el.duration;
					// Track seekable range for live non-TL videos
					if (el.duration === Infinity && el.seekable.length > 0) {
						seekableEnd = el.seekable.end(el.seekable.length - 1);
					}
					// Save progress
					const cv = playerStore.currentVideo;
					if (cv && !cv.isLive) {
						localStorage.setItem(
							STORAGE_KEYS.PROGRESS_PREFIX + cv.filename,
							String(Math.round(el.currentTime))
						);
					}
				}
			};
			const onVolumeChange = () => {
				if (el === getActiveElement()) {
					isMuted = el.muted;
				}
			};
			el.addEventListener('timeupdate', onTimeUpdate);
			el.addEventListener('volumechange', onVolumeChange);
			cleanups.push(() => {
				el.removeEventListener('timeupdate', onTimeUpdate);
				el.removeEventListener('volumechange', onVolumeChange);
			});
		});

		return () => cleanups.forEach((fn) => fn());
	});

	// Wake lock: acquire when playing, release when not
	$effect(() => {
		updateWakeLock(playerStore.view === 'video' && !!playerStore.currentVideo);
	});

	// Destroy all streams when provider changes (stops hls.js polling)
	let lastProvider: string | null = null;
	$effect(() => {
		const provider = videoListStore.selectedProvider;
		if (lastProvider !== null && lastProvider !== provider && videoElements.length > 0) {
			videoElements.forEach(clearStream);
			currentFilename = null;
		}
		lastProvider = provider;
	});

	// Cleanup when returning to list view
	$effect(() => {
		if (playerStore.view !== 'list' || videoElements.length === 0) return;
		playerStore.swipeAnimating = false;
		getActiveElement()?.pause();
		if (videoListStore.selectedProvider === 'tl') sendActiveSet([]);
	});

	// Cleanup when video is cleared
	$effect(() => {
		if (playerStore.view !== 'video' || playerStore.currentVideo || videoElements.length === 0)
			return;
		stopPlayback();
	});

	// Activate video when it changes
	$effect(() => {
		const cv = playerStore.currentVideo;
		if (!cv || playerStore.view !== 'video' || videoElements.length === 0) return;
		const activeIdx = playerStore.activePlayerIndex;

		const videoChanged = currentFilename !== cv.filename;
		currentFilename = cv.filename;

		videoElements.forEach((el, i) => {
			if (i === activeIdx) {
				if (videoChanged) el.style.opacity = '0';
				el.className = 'active-player';
			} else {
				el.style.opacity = '';
				el.className = 'background-player';
				el.muted = true;
			}
		});

		const activeEl = videoElements[activeIdx];
		isMuted = activeEl.muted;

		if (videoChanged) {
			resetZoom();
			void activatePlayer(activeEl, cv, playerStore.currentVideoStartTime);
		} else if (activeEl.paused) {
			void activeEl.play();
		}
	});

	// Fetch co-streamers on-demand when a tl video activates
	$effect(() => {
		const cv = playerStore.currentVideo;
		if (!cv || playerStore.view !== 'video' || videoListStore.selectedProvider !== 'tl') return;
		const streamer = videoListStore.getStreamer(cv.filename);
		if (!streamer?.streamId || !videoListStore.markStreamIdProcessed(streamer.streamId)) return;
		const epoch = videoListStore.epoch;
		console.log('[TL:co] on-demand fetch for', streamer.alias, streamer.streamId);
		fetchMultiBroadcast(streamer.streamId).then((coStreamers) => {
			if (videoListStore.epoch !== epoch) return;
			if (coStreamers.length === 0) {
				console.log('[TL:co] no co-streamers for', streamer.alias);
				return;
			}
			console.log(
				'[TL:co] found',
				coStreamers.length,
				'co-streamers for',
				streamer.alias,
				':',
				coStreamers.map((s) => s.alias).join(', ')
			);
			const withParent = coStreamers.map((s) => ({ ...s, parentAlias: streamer.alias }));
			const newVideos = withParent.map((s) => ({
				filename: s.alias,
				type: VIDEO_TYPE.ORIGINAL,
				duration: 0,
				size: 0,
				isLive: true
			}));
			videoListStore.insertVideosAfter(cv.filename, newVideos, withParent);
		});
	});

	// Preload adjacent — depends on video list and active index, not on currentVideo identity
	$effect(() => {
		const view = playerStore.view;
		if (view !== 'video' || videoElements.length === 0) return;
		const activeIdx = playerStore.activePlayerIndex;
		const filteredList = filterByAliases(videoListStore.videos, videoListStore.selectedAliases);
		const cv = untrack(() => playerStore.currentVideo);
		if (!cv) return;
		preloadAdjacent(cv, activeIdx, filteredList);
	});

	// Watch reloadToken to force-reload current video (after cut completes)
	let lastReloadToken = 0;
	$effect(() => {
		const token = playerStore.reloadToken;
		if (token > lastReloadToken && videoElements.length > 0) {
			lastReloadToken = token;
			const cv = playerStore.currentVideo;
			if (cv) {
				const activeEl = getActiveElement();
				forceReloadStream(activeEl, cv);
			}
		}
	});

	function getActiveElement(): HTMLVideoElement {
		return videoElements[playerStore.activePlayerIndex];
	}

	async function activatePlayer(el: HTMLVideoElement, v: Video, startTime: number) {
		await loadStream(el, v, startTime, true);

		try {
			await el.play();
		} catch (e) {
			console.warn('Playback failed', e);
		}
		el.style.opacity = '1';
	}

	function resolveStreamUrl(filename: string): string {
		if (videoListStore.selectedProvider === 'tl') {
			const proxyUrl = getProxyUrl(filename);
			if (proxyUrl) return proxyUrl;
			const hlsFilename = videoListStore.getLiveFilename(filename) || filename;
			return API.HLS_PLAYLIST(hlsFilename);
		}
		return API.HLS_PLAYLIST(filename);
	}

	function handleVideoGone(): void {
		const next = findAdjacentVideo(1);
		if (next) {
			const saved = getSavedTime(next);
			playerStore.navigateVideo(next, saved, 1, videoListStore.selectedProvider);
		} else {
			playerStore.showList();
		}
	}

	function handleBlock(alias: string, streamerId: string) {
		blockStreamer(streamerId).catch(() => {});
		const next = findAdjacentVideo(1) || findAdjacentVideo(-1);
		videoListStore.removeVideo(alias);
		if (next) {
			const saved = getSavedTime(next);
			playerStore.navigateVideo(next, saved, 1, videoListStore.selectedProvider);
		} else {
			playerStore.showList();
		}
	}

	function syncLiveStatus(el: HTMLVideoElement, v: Video, isActivePlayer: boolean): void {
		if (!isActivePlayer) return;
		const isLive = el.duration === Infinity;
		if (isLive) {
			playerStore.setCurrentVideoLive();
			videoListStore.updateVideoLive(v.filename, true);
		} else if (v.isLive) {
			playerStore.setCurrentVideoNotLive();
			videoListStore.updateVideoLive(v.filename, false);
			clearPlaylistCache(v.filename);
		}
	}

	function setupHlsJs(
		el: HTMLVideoElement,
		url: string,
		v: Video,
		startTime: number,
		isActivePlayer: boolean,
		resolve: () => void
	): void {
		const oldHls = hlsInstances.get(el);
		if (oldHls) {
			oldHls.destroy();
			hlsInstances.delete(el);
		}

		const hls = new Hls();
		hlsInstances.set(el, hls);

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
						playerStore.setCurrentVideoLive();
						videoListStore.updateVideoLive(v.filename, true);
					}
				} else if (startTime > 0) {
					el.currentTime = startTime;
				}
				return;
			}

			// Detect live → ended transition
			if (wasLive && !isLive) {
				wasLive = false;
				if (isActivePlayer) {
					playerStore.setCurrentVideoNotLive();
					videoListStore.updateVideoLive(v.filename, false);
					clearPlaylistCache(v.filename);
				}
			}
		});

		hls.on(Hls.Events.ERROR, (_event, data) => {
			if (data.fatal) {
				console.warn('HLS fatal error', data.type, data.details);
				if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
					if (data.response?.code === 404) {
						if (!isActivePlayer) {
							hls.destroy();
							hlsInstances.delete(el);
							return;
						}
						// TL streams may 404 briefly while download starts — retry
						if (videoListStore.selectedProvider === 'tl') {
							console.log('[TL:hls] 404 on active player, retrying:', v.filename);
							hls.startLoad();
							return;
						}
						videoListStore.removeVideo(v.filename);
						handleVideoGone();
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

	function setupNativeHls(
		el: HTMLVideoElement,
		url: string,
		v: Video,
		startTime: number,
		isActivePlayer: boolean,
		resolve: () => void
	): void {
		const oldController = nativeAbortControllers.get(el);
		if (oldController) oldController.abort();
		const controller = new AbortController();
		nativeAbortControllers.set(el, controller);
		const signal = controller.signal;

		let nativeWasLive = false;
		const onReady = () => {
			if (el.duration === Infinity) {
				nativeWasLive = true;
				if (isActivePlayer) {
					playerStore.setCurrentVideoLive();
					videoListStore.updateVideoLive(v.filename, true);
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
					playerStore.setCurrentVideoNotLive();
					videoListStore.updateVideoLive(v.filename, false);
					clearPlaylistCache(v.filename);
				}
			}
		};
		const onError = () => {
			const mediaError = el.error;
			if (mediaError) {
				console.warn('Native HLS error', mediaError.code, mediaError.message);
				if (!isActivePlayer) return;
				// TL streams may error briefly while download starts — don't remove
				if (videoListStore.selectedProvider === 'tl') {
					console.log('[TL:native] error on active player, ignoring:', v.filename);
					return;
				}
				videoListStore.removeVideo(v.filename);
				handleVideoGone();
			}
		};
		el.addEventListener('loadedmetadata', onReady, { once: true, signal });
		el.addEventListener('durationchange', onDurationChange, { signal });
		el.addEventListener('error', onError, { signal });
		el.src = url;
	}

	function loadStream(
		el: HTMLVideoElement,
		v: Video,
		startTime: number,
		isActivePlayer = false
	): Promise<void> {
		return new Promise((resolve) => {
			if (el.dataset.loadedFilename === v.filename) {
				syncLiveStatus(el, v, isActivePlayer);
				if (startTime > 0) el.currentTime = startTime;
				resolve();
				return;
			}

			const url = resolveStreamUrl(v.filename);

			if (!USE_NATIVE_HLS && Hls.isSupported()) {
				setupHlsJs(el, url, v, startTime, isActivePlayer, resolve);
			} else {
				setupNativeHls(el, url, v, startTime, isActivePlayer, resolve);
			}

			el.dataset.loadedFilename = v.filename;
		});
	}

	function forceReloadStream(el: HTMLVideoElement, v: Video) {
		// Clear the cached filename so loadStream doesn't skip
		delete el.dataset.loadedFilename;
		void activatePlayer(el, v, 0);
	}

	function clearStream(el: HTMLVideoElement) {
		el.pause();
		el.style.opacity = '';

		// Destroy hls.js instance
		const hls = hlsInstances.get(el);
		if (hls) {
			hls.destroy();
			hlsInstances.delete(el);
		}

		// Abort native HLS event listeners
		const controller = nativeAbortControllers.get(el);
		if (controller) {
			controller.abort();
			nativeAbortControllers.delete(el);
		}

		el.removeAttribute('src');
		if (el.dataset.loadedFilename) {
			el.load();
		}
		delete el.dataset.loadedFilename;
	}

	function stopPlayback() {
		if (videoListStore.selectedProvider === 'tl') {
			sendActiveSet([]);
			syncProxySessions([]);
		}
		currentFilename = null;
		videoElements.forEach(clearStream);
	}

	function preloadAdjacent(cv: Video, activeIdx: number, filteredList: Video[]) {
		const idx = filteredList.findIndex((v) => v.filename === cv.filename && v.type === cv.type);
		if (idx === -1) return;

		const nextVideo = idx < filteredList.length - 1 ? filteredList[idx + 1] : null;
		const prevVideo = idx > 0 ? filteredList[idx - 1] : null;

		// Report active set to server for cleanup
		if (videoListStore.selectedProvider === 'tl') {
			const active = [cv.filename];
			if (nextVideo) active.push(nextVideo.filename);
			if (prevVideo) active.push(prevVideo.filename);
			// Only include aliases that have ephemeral downloads (not following with live filename)
			const ephemeral = active.filter(
				(a) => !videoListStore.getLiveFilename(a) || !videoListStore.getStreamer(a)?.isFollowing
			);
			sendActiveSet(ephemeral);
			syncProxySessions(active);
		}

		const nextPlayer = videoElements[(activeIdx + 1) % 3];
		if (nextVideo) {
			void preloadAndPlay(nextPlayer, nextVideo);
		} else {
			clearStream(nextPlayer);
		}

		const prevPlayer = videoElements[(activeIdx + 2) % 3];
		if (prevVideo) {
			void preloadAndPause(prevPlayer, prevVideo);
		} else {
			clearStream(prevPlayer);
		}
	}

	async function ensureTlStream(v: Video) {
		if (videoListStore.selectedProvider !== 'tl') return;
		const streamer = videoListStore.getStreamer(v.filename);
		if (!streamer) return;
		// Start proxy (await so URL is available for loadStream)
		await startProxy(streamer);
		// Also start download for archival (skip for followed streams with live filename)
		if (!(streamer.isFollowing && videoListStore.getLiveFilename(v.filename))) {
			void startDownload(streamer);
		}
	}

	async function preloadAndPlay(el: HTMLVideoElement, v: Video) {
		await ensureTlStream(v);
		const startTime = getSavedTime(v);
		await loadStream(el, v, startTime);
		el.muted = true;
		try {
			if (el.paused) await el.play();
		} catch (e) {
			console.warn('Autoplay muted failed', e);
		}
	}

	async function preloadAndPause(el: HTMLVideoElement, v: Video) {
		await ensureTlStream(v);
		const startTime = getSavedTime(v);
		await loadStream(el, v, startTime);
		if (!el.paused) el.pause();
	}

	function getSavedTime(v: Video): number {
		return parseFloat(localStorage.getItem(STORAGE_KEYS.PROGRESS_PREFIX + v.filename) || '0');
	}

	async function navigateToVideo(target: Video, dir: 1 | -1) {
		const myNav = ++navCounter;
		if (videoListStore.selectedProvider === 'tl') {
			const streamer = videoListStore.getStreamer(target.filename);
			if (streamer) {
				await startProxy(streamer);
				if (!(streamer.isFollowing && videoListStore.getLiveFilename(target.filename))) {
					void startDownload(streamer);
				}
			}
			if (myNav !== navCounter) return;
		}
		const saved = getSavedTime(target);
		playerStore.navigateVideo(target, saved, dir, videoListStore.selectedProvider);
		void fetchAndParsePlaylist(target);
	}

	function findAdjacentVideo(direction: 1 | -1): Video | null {
		const cv = playerStore.currentVideo;
		if (!cv) return null;
		const filteredList = filterByAliases(videoListStore.videos, videoListStore.selectedAliases);
		if (filteredList.length < 2) return null;
		const idx = filteredList.findIndex((v) => v.filename === cv.filename && v.type === cv.type);
		if (idx === -1) return null;
		for (let i = idx + direction; i >= 0 && i < filteredList.length; i += direction) {
			if (filteredList[i].filename !== cv.filename) return filteredList[i];
		}
		return null;
	}

	function handleSeek(time: number) {
		const activeEl = getActiveElement();
		if (!isNaN(activeEl.duration)) {
			const wasPlaying = !activeEl.paused;
			if (wasPlaying) activeEl.pause();
			activeEl.currentTime = time;
			if (wasPlaying) {
				activeEl.addEventListener('seeked', () => void activeEl.play(), { once: true });
			}
		}
	}

	function toggleMute() {
		const activeEl = getActiveElement();
		activeEl.muted = !activeEl.muted;
	}

	async function updateWakeLock(shouldBeActive: boolean) {
		if (shouldBeActive && !wakeLock) {
			if ('wakeLock' in navigator) {
				try {
					wakeLock = await navigator.wakeLock.request('screen');
				} catch (e) {
					console.warn('Wake lock failed', e);
				}
			}
		} else if (!shouldBeActive && wakeLock) {
			await wakeLock.release();
			wakeLock = null;
		}
	}
	// Attach touch handlers imperatively (touchmove needs passive: false for preventDefault)
	$effect(() => {
		if (!videoViewEl) return;
		const el = videoViewEl;
		el.addEventListener('touchstart', handleTouchStart);
		el.addEventListener('touchmove', handleTouchMove, { passive: false });
		el.addEventListener('touchend', handleTouchEnd);
		el.addEventListener('touchcancel', handleTouchCancel);
		return () => {
			el.removeEventListener('touchstart', handleTouchStart);
			el.removeEventListener('touchmove', handleTouchMove);
			el.removeEventListener('touchend', handleTouchEnd);
			el.removeEventListener('touchcancel', handleTouchCancel);
		};
	});

	// Gesture system
	const EDGE_ZONE = 30;
	const EDGE_BACK_THRESHOLD = 0.3;
	const FLICK_THRESHOLD = 80;
	const UI_SWIPE_THRESHOLD = 80;
	const SEEK_RATE = 60;
	const MAX_ZOOM = 5;
	const ZOOM_THRESHOLD = 1.01;
	let swipeStartX = 0;
	let swipeStartY = 0;
	let swipeAxis: 'none' | 'horizontal' | 'vertical' = 'none';
	let swipeType: 'none' | 'edge-back' | 'seek' | 'nav' | 'ui' | 'pinch' = 'none';
	let seekBaseTime = 0;

	// Pinch-to-zoom state
	let zoomScale = $state(1);
	let zoomX = $state(0);
	let zoomY = $state(0);
	let pinchStartDist = 0;
	let pinchStartScale = 0;
	let pinchContentAnchorX = 0;
	let pinchContentAnchorY = 0;
	let lastZoomEnd = 0;
	let wasMultiTouch = false;
	const ZOOM_DEBOUNCE_MS = 200;

	function getPinchDist(e: TouchEvent): number {
		const [a, b] = [e.touches[0], e.touches[1]];
		return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
	}

	function getPinchMid(e: TouchEvent): [number, number] {
		const [a, b] = [e.touches[0], e.touches[1]];
		return [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
	}

	function initPinch(e: TouchEvent) {
		pinchStartDist = Math.max(1, getPinchDist(e));
		pinchStartScale = zoomScale;
		const [midX, midY] = getPinchMid(e);
		const cx = window.innerWidth / 2;
		const cy = window.innerHeight / 2;
		pinchContentAnchorX = (midX - cx - zoomX) / zoomScale;
		pinchContentAnchorY = (midY - cy - zoomY) / zoomScale;
	}

	function clampTranslate() {
		if (zoomScale <= 1) {
			zoomX = 0;
			zoomY = 0;
			return;
		}
		const maxX = ((zoomScale - 1) * window.innerWidth) / 2;
		const maxY = ((zoomScale - 1) * window.innerHeight) / 2;
		zoomX = Math.max(-maxX, Math.min(maxX, zoomX));
		zoomY = Math.max(-maxY, Math.min(maxY, zoomY));
	}

	function resetZoom() {
		zoomScale = 1;
		zoomX = 0;
		zoomY = 0;
	}

	function handleTouchCancel() {
		if (zoomScale <= ZOOM_THRESHOLD) resetZoom();
		wasMultiTouch = false;
		swipeType = 'none';
		swipeAxis = 'none';
		if (playerStore.isSwiping) {
			playerStore.isSwiping = false;
			playerStore.swipeAnimating = false;
			playerStore.swipeProgress = 0;
		}
	}

	function handleTouchStart(e: TouchEvent) {
		if (playerStore.swipeAnimating) return;

		if (e.touches.length === 2) {
			wasMultiTouch = true;
			swipeType = 'pinch';
			swipeAxis = 'none';
			initPinch(e);
			return;
		}

		// Block all single-finger gestures during/after multi-touch
		if (wasMultiTouch || Date.now() - lastZoomEnd < ZOOM_DEBOUNCE_MS) return;

		const touch = e.touches[0];
		swipeStartX = touch.clientX;
		swipeStartY = touch.clientY;
		swipeAxis = 'none';
		swipeType = 'none';
	}

	function handleTouchMove(e: TouchEvent) {
		e.preventDefault();
		if (playerStore.swipeAnimating) return;

		// Pinch zoom (2 fingers)
		if (e.touches.length === 2) {
			if (swipeType !== 'pinch') {
				swipeType = 'pinch';
				initPinch(e);
				return;
			}
			const newDist = getPinchDist(e);
			const newScale = Math.max(
				1,
				Math.min(MAX_ZOOM, pinchStartScale * (newDist / pinchStartDist))
			);
			const [midX, midY] = getPinchMid(e);
			const cx = window.innerWidth / 2;
			const cy = window.innerHeight / 2;
			zoomX = midX - cx - newScale * pinchContentAnchorX;
			zoomY = midY - cy - newScale * pinchContentAnchorY;
			zoomScale = newScale;
			return;
		}

		// Single finger
		const touch = e.touches[0];
		const dx = touch.clientX - swipeStartX;
		const dy = touch.clientY - swipeStartY;

		// Normal swipe gestures
		if (swipeAxis === 'none') {
			if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
			if (Math.abs(dx) >= Math.abs(dy)) {
				swipeAxis = 'horizontal';
				if (swipeStartX <= EDGE_ZONE && dx > 0) {
					swipeType = 'edge-back';
					playerStore.isSwiping = true;
				} else if (swipeStartY < window.innerHeight / 2 && (!playerStore.currentVideo?.isLive || !isTl)) {
					swipeType = 'seek';
					seekBaseTime = getActiveElement().currentTime;
				} else {
					swipeType = 'ui';
				}
			} else {
				swipeAxis = 'vertical';
				swipeType = 'nav';
			}
		}

		if (swipeType === 'edge-back') {
			const progress = Math.max(0, Math.min(1, dx / window.innerWidth));
			playerStore.swipeProgress = progress;
		} else if (swipeType === 'seek') {
			const seekDelta = (dx / window.innerWidth) * SEEK_RATE;
			const activeEl = getActiveElement();
			const maxTime = activeEl.duration === Infinity ? seekableEnd : activeEl.duration;
			if (!isNaN(maxTime) && maxTime > 0) {
				const newTime = Math.max(0, Math.min(maxTime, seekBaseTime + seekDelta));
				activeEl.currentTime = newTime;
				currentTime = newTime;
			}
		}
	}

	function handleTouchEnd(e: TouchEvent) {
		if (swipeType === 'pinch') {
			if (e.touches.length > 0) return;
			if (zoomScale <= ZOOM_THRESHOLD) {
				resetZoom();
			} else {
				clampTranslate();
			}
			lastZoomEnd = Date.now();
			wasMultiTouch = false;
			swipeType = 'none';
			swipeAxis = 'none';
			return;
		}

		const touch = e.changedTouches[0];
		const dx = touch.clientX - swipeStartX;
		const dy = touch.clientY - swipeStartY;

		switch (swipeType) {
			case 'edge-back': {
				const progress = playerStore.swipeProgress;
				playerStore.swipeAnimating = true;
				if (progress > EDGE_BACK_THRESHOLD) {
					playerStore.swipeProgress = 1;
					setTimeout(() => {
						playerStore.showList();
						playerStore.isSwiping = false;
						playerStore.swipeAnimating = false;
						playerStore.swipeProgress = 0;
					}, 250);
				} else {
					playerStore.swipeProgress = 0;
					setTimeout(() => {
						playerStore.isSwiping = false;
						playerStore.swipeAnimating = false;
					}, 250);
				}
				break;
			}
			case 'nav': {
				if (Math.abs(dy) > FLICK_THRESHOLD) {
					const dir = dy < 0 ? 1 : -1;
					const target = findAdjacentVideo(dir as 1 | -1);
					if (target) {
						void navigateToVideo(target, dir as 1 | -1);
					}
				}
				break;
			}
			case 'ui': {
				if (Math.abs(dx) > UI_SWIPE_THRESHOLD) {
					playerStore.isUiVisible = dx > 0;
				}
				break;
			}
		}
		swipeAxis = 'none';
		swipeType = 'none';
	}
</script>

<div
	class="video-view"
	class:visible={isVisible}
	class:swipe-active={playerStore.isSwiping}
	class:swipe-animating={playerStore.swipeAnimating}
	style:transform={playerStore.isSwiping || playerStore.swipeAnimating
		? `translateX(${playerStore.swipeProgress * 100}%)`
		: null}
	role="application"
	bind:this={videoViewEl}
>
	<div class="video-container">
		<div
			class="video-player"
			bind:this={videoContainer}
			style:transform={zoomScale > 1 ? `translate(${zoomX}px,${zoomY}px) scale(${zoomScale})` : null}
		></div>

		<div class="top-bar" class:ui-visible={playerStore.isUiVisible && !!video}>
			{#if video}
				<div class="streamer-name">{video.filename}{#if isTl}{@const s = videoListStore.getStreamer(video.filename)}{#if s}{` ${s.firstName}`}{/if}{/if}</div>

				<ProgressBar {currentTime} duration={displayDuration} onseek={handleSeek} />

				{#if isTl}
					<TlControls {isMuted} ontoggleMute={toggleMute} onblock={handleBlock} />
				{:else}
					<PlayerControls {isMuted} {currentTime} ontoggleMute={toggleMute} />
				{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	.video-view {
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100dvh;
		background-color: black;
		-webkit-user-select: none;
		user-select: none;
		touch-action: none;
		z-index: -1;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.3s ease;
	}

	.video-view.visible {
		z-index: 10;
		opacity: 1;
		pointer-events: auto;
	}

	.video-container {
		width: 100%;
		height: 100%;
		position: relative;
		display: block;
		overflow: hidden;
		background-color: #000;
	}

	.video-player {
		width: 100%;
		height: 100%;
		position: absolute;
		top: 0;
		left: 0;
	}

	.video-player :global(video) {
		width: 100% !important;
		height: 100% !important;
		object-fit: contain;
		background-color: #000;
		position: absolute;
		top: 0;
		left: 0;
		border: none;
		outline: none;
		display: block;
	}

	.video-player :global(.active-player) {
		z-index: 5;
		opacity: 1;
	}

	.video-player :global(.background-player) {
		z-index: 1;
		opacity: 0;
	}

	.top-bar {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		padding: calc(env(safe-area-inset-top, 0px) + 15px) 15px 15px 15px;
		box-sizing: border-box;
		background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0));
		z-index: 20;
		transition: opacity 0.3s ease;
		opacity: 0;
		pointer-events: none;
	}

	.top-bar.ui-visible {
		opacity: 1;
		pointer-events: auto;
	}

	.streamer-name {
		font-size: 1.2em;
		font-weight: bold;
		text-shadow: 1px 1px 2px black;
		margin-bottom: 10px;
		word-break: break-all;
	}
	.video-view.swipe-active {
		box-shadow: -10px 0 30px rgba(0, 0, 0, 0.3);
	}

	.video-view.swipe-animating {
		transition: transform 250ms ease-out;
	}
</style>
