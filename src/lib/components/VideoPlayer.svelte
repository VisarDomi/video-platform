<script lang="ts">
	import Hls from 'hls.js';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { QUADRANT_ACTIONS, STORAGE_KEYS, API } from '$lib/constants.js';
	import { filterByAliases } from '$lib/utils/filter.js';
	import { fetchAndParsePlaylist } from '$lib/services/hls.js';
	import { saveCurrentVideo, createEditedVideo, returnToOriginals } from '$lib/services/videoActions.js';
	import QuadrantOverlay from './QuadrantOverlay.svelte';
	import ProgressBar from './ProgressBar.svelte';
	import PlayerControls from './PlayerControls.svelte';
	import type { Video } from '$lib/types.js';

	let videoElements = $state<HTMLVideoElement[]>([]);
	let videoContainer = $state<HTMLElement | null>(null);
	let currentTime = $state(0);
	let duration = $state(0);
	let isMuted = $state(true);
	let currentFilename = $state<string | null>(null);
	let wakeLock = $state<WakeLockSentinel | null>(null);

	const hlsInstances = new Map<HTMLVideoElement, Hls>();

	const isVisible = $derived(playerStore.view === 'video');
	const video = $derived(playerStore.currentVideo);

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

	// Sync player state when video/view changes
	$effect(() => {
		const cv = playerStore.currentVideo;
		const view = playerStore.view;
		const activeIdx = playerStore.activePlayerIndex;

		if (videoElements.length === 0) return;

		if (view === 'list') {
			getActiveElement()?.pause();
			updateWakeLock(false);
			return;
		}

		if (!cv) {
			stopPlayback();
			updateWakeLock(false);
			return;
		}

		updateWakeLock(true);

		const videoChanged = currentFilename !== cv.filename;
		currentFilename = cv.filename;

		// Update CSS classes and inline opacity
		videoElements.forEach((el, i) => {
			if (i === activeIdx) {
				el.style.opacity = '0';
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
			void activatePlayer(activeEl, cv, playerStore.currentVideoStartTime);
		} else if (activeEl.paused) {
			void activeEl.play();
		}

		// Preload adjacent
		const filteredList = filterByAliases(videoListStore.videos, videoListStore.selectedAliases);
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
		await loadStream(el, v, startTime);

		try {
			await el.play();
		} catch (e) {
			console.warn('Playback failed', e);
		}
		el.style.opacity = '1';
	}

	function loadStream(el: HTMLVideoElement, v: Video, startTime: number): Promise<void> {
		return new Promise((resolve) => {
			if (el.dataset.loadedFilename === v.filename) {
				const isLive = el.duration === Infinity;
				if (isLive) {
					playerStore.setCurrentVideoLive();
				} else if (startTime > 0) {
					el.currentTime = startTime;
				}
				resolve();
				return;
			}

			const url = API.HLS_PLAYLIST(v.filename);

			if (Hls.isSupported()) {
				// Destroy previous hls.js instance for this element
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

				let liveDetected = false;
				hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
					if (liveDetected) return;
					liveDetected = true;
					if (data.details.live) {
						if (playerStore.currentVideo?.filename === v.filename) {
							playerStore.setCurrentVideoLive();
						}
					} else if (startTime > 0) {
						el.currentTime = startTime;
					}
				});

				hls.on(Hls.Events.ERROR, (_event, data) => {
					if (data.fatal) {
						console.warn('HLS fatal error', data.type, data.details);
						if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
							if (data.response?.code === 404) {
								videoListStore.removeVideo(v.filename);
								const next = findAdjacentVideo(1);
								if (next) {
									const saved = getSavedTime(next);
									playerStore.navigateVideo(next, saved, 1, videoListStore.selectedProvider);
								} else {
									playerStore.showList();
								}
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
			} else {
				// Safari native HLS fallback
				const onReady = () => {
					el.removeEventListener('loadedmetadata', onReady);
					if (el.duration === Infinity) {
						playerStore.setCurrentVideoLive();
					} else if (startTime > 0) {
						el.currentTime = startTime;
					}
					resolve();
				};
				el.addEventListener('loadedmetadata', onReady, { once: true });
				el.src = url;
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

		el.removeAttribute('src');
		if (el.dataset.loadedFilename) {
			el.load();
		}
		delete el.dataset.loadedFilename;
	}

	function stopPlayback() {
		currentFilename = null;
		videoElements.forEach(clearStream);
	}

	function preloadAdjacent(cv: Video, activeIdx: number, filteredList: Video[]) {
		const idx = filteredList.findIndex(
			(v) => v.filename === cv.filename && v.type === cv.type
		);
		if (idx === -1) return;

		const nextVideo = idx < filteredList.length - 1 ? filteredList[idx + 1] : null;
		const prevVideo = idx > 0 ? filteredList[idx - 1] : null;

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

	async function preloadAndPlay(el: HTMLVideoElement, v: Video) {
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
		const startTime = getSavedTime(v);
		await loadStream(el, v, startTime);
		if (!el.paused) el.pause();
	}

	function getSavedTime(v: Video): number {
		return parseFloat(
			localStorage.getItem(STORAGE_KEYS.PROGRESS_PREFIX + v.filename) || '0'
		);
	}

	function findAdjacentVideo(direction: 1 | -1): Video | null {
		const cv = playerStore.currentVideo;
		if (!cv) return null;
		const filteredList = filterByAliases(videoListStore.videos, videoListStore.selectedAliases);
		if (filteredList.length < 2) return null;
		const idx = filteredList.findIndex(
			(v) => v.filename === cv.filename && v.type === cv.type
		);
		if (idx === -1) return null;
		const newIdx = idx + direction;
		if (newIdx < 0 || newIdx >= filteredList.length) return null;
		return filteredList[newIdx];
	}

	function handleQuadrantAction(action: string) {
		if (action === QUADRANT_ACTIONS.TOGGLE_UI) {
			playerStore.toggleUi();
			return;
		}

		// In opaque mode (UI visible), only toggle-ui works
		if (playerStore.isUiVisible) return;

		const activeEl = getActiveElement();
		switch (action) {
			case QUADRANT_ACTIONS.NEXT: {
				const next = findAdjacentVideo(1);
				if (next) {
					const saved = getSavedTime(next);
					playerStore.navigateVideo(next, saved, 1, videoListStore.selectedProvider);
					void fetchAndParsePlaylist(next);
				}
				break;
			}
			case QUADRANT_ACTIONS.PREV: {
				const prev = findAdjacentVideo(-1);
				if (prev) {
					const saved = getSavedTime(prev);
					playerStore.navigateVideo(prev, saved, -1, videoListStore.selectedProvider);
					void fetchAndParsePlaylist(prev);
				}
				break;
			}
			case QUADRANT_ACTIONS.SEEK_FORWARD:
				if (!isNaN(activeEl.duration)) {
					activeEl.currentTime = Math.min(activeEl.duration, activeEl.currentTime + 5);
				}
				break;
			case QUADRANT_ACTIONS.SEEK_BACKWARD:
				activeEl.currentTime = Math.max(0, activeEl.currentTime - 5);
				void activeEl.play();
				break;
		}
	}

	function handleSeek(time: number) {
		const activeEl = getActiveElement();
		if (!isNaN(activeEl.duration)) {
			activeEl.currentTime = time;
		}
	}

	function toggleMute() {
		const activeEl = getActiveElement();
		activeEl.muted = !activeEl.muted;
	}

	function handleAddPoint() {
		const activeEl = getActiveElement();
		playerStore.addSegment(activeEl.currentTime);
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
</script>

<div
	class="video-view"
	class:visible={isVisible}
	role="application"
	ondblclick={(e) => e.preventDefault()}
	ontouchmove={(e) => e.preventDefault()}
>
	<div class="video-container">
		<div class="video-player" bind:this={videoContainer}></div>

		{#if video}
			<QuadrantOverlay onaction={handleQuadrantAction} />
		{/if}

		<div class="top-bar" class:ui-visible={playerStore.isUiVisible && !!video}>
			{#if video}
				<div class="streamer-name">{video.filename}</div>

				<ProgressBar {currentTime} {duration} onseek={handleSeek} />

				<PlayerControls
					{isMuted}
					onback={() => playerStore.showList()}
					ontoggleMute={toggleMute}
					onaddpoint={handleAddPoint}
					onsave={saveCurrentVideo}
					oncut={() => void createEditedVideo()}
					onreturn={returnToOriginals}
				/>
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
</style>
