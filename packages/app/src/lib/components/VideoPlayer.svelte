<script lang="ts">
	import { onMount } from 'svelte';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { untrack } from 'svelte';
	import { VideoEngine } from '$lib/engine/VideoEngine.js';
	import { GestureController } from '$lib/engine/GestureController.js';
	import { ConnectionMonitor } from '$lib/services/ConnectionMonitor.svelte.js';
	import { WatchdogService } from '$lib/services/WatchdogService.js';
	import { findAdjacentVideo, getSavedTime } from '$lib/utils/navigation.js';
	import { fetchAndParsePlaylist } from '$lib/services/hls.js';

	import ProgressBar from './ProgressBar.svelte';
	import PlayerControls from './PlayerControls.svelte';

	let videoViewEl = $state<HTMLElement | null>(null);
	let videoContainer = $state<HTMLElement | null>(null);
	let currentTime = $state(0);
	let duration = $state(0);
	let seekableEnd = $state(0);
	let isMuted = $state(true);

	const isVisible = $derived(playerStore.view === 'video');
	const video = $derived(playerStore.currentVideo);
	const displayDuration = $derived(
		duration === Infinity && seekableEnd > 0 ? seekableEnd : duration
	);

	const engine = new VideoEngine({
		onTimeUpdate(ct, dur, se) {
			currentTime = ct;
			duration = dur;
			seekableEnd = se;
		},
		onMuteChange(muted) {
			isMuted = muted;
		},
		onLiveStatusChanged(filename, isLive) {
			if (isLive) {
				playerStore.setCurrentVideoLive();
				videoListStore.updateVideoLive(filename, true);
			} else {
				playerStore.setCurrentVideoNotLive();
				videoListStore.updateVideoLive(filename, false);
			}
		},
		onVideoRemoved(filename) {
			videoListStore.removeVideo(filename);
			const cv = playerStore.currentVideo;
			if (!cv) return;
			const filteredList = videoListStore.filteredVideos;
			const next = findAdjacentVideo(cv, filteredList, 1);
			if (next) {
				engine.forceProgressSave();
				playerStore.navigateVideo(next, getSavedTime(next), 1, videoListStore.selectedProvider);
				void fetchAndParsePlaylist(next);
			} else if (filteredList.length > 0) {
				const first = filteredList[0];
				engine.forceProgressSave();
				playerStore.navigateVideo(first, getSavedTime(first), 1, videoListStore.selectedProvider);
				void fetchAndParsePlaylist(first);
			} else {
				playerStore.showList();
			}
		}
	});

	const doNavigate = (dir: 1 | -1) => {
		const cv = playerStore.currentVideo;
		if (!cv) return;
		const target = findAdjacentVideo(cv, videoListStore.filteredVideos, dir);
		if (target) {
			engine.forceProgressSave();
			playerStore.navigateVideo(target, getSavedTime(target), dir, videoListStore.selectedProvider);
			playerStore.updateScrollTarget(target);
			void fetchAndParsePlaylist(target);
		}
	};

	const gesture = new GestureController(playerStore, {
		getSeekBase: () => engine.getCurrentTime(),
		getSeekMaxTime: () => {
			const dur = engine.getDuration();
			const se = engine.getSeekableEnd();
			return dur === Infinity && se > 0 ? se : dur;
		},
		seekDirect: (t) => engine.seekDirect(t),
		seekFinish: () => engine.forceTimeSync(),
		navigate: doNavigate,
		navPeekUpdate: (dy) => engine.navPeekUpdate(dy),
		navPeekRelease: (dy, onDone) => engine.navPeekRelease(dy, doNavigate, onDone),
		navPeekCancel: () => engine.navPeekCancel()
	});

	// --- Reconnection / freeze recovery ---
	const RESUME_THRESHOLD_MS = 3000;
	let backgroundedAt = 0;
	let sentinelId: ReturnType<typeof setInterval> | null = null;

	const watchdog = new WatchdogService();
	watchdog.setOnFreeze(() => {
		if (playerStore.view === 'video' && playerStore.currentVideo) {
			console.log('[VideoPlayer] Watchdog freeze → resuming');
			engine.resume();
		}
	});

	function handleVisibilityChange(visible: boolean) {
		if (!visible) {
			backgroundedAt = Date.now();
			engine.forceProgressSave();
			watchdog.stop();
			// Start sentinel: fallback for iOS missing visibilitychange on return
			if (sentinelId) clearInterval(sentinelId);
			let sentinelLast = Date.now();
			sentinelId = setInterval(() => {
				const now = Date.now();
				const delta = now - sentinelLast;
				sentinelLast = now;
				if (delta > 3000 && document.visibilityState === 'visible') {
					console.log(`[VideoPlayer] Sentinel: visibilitychange missed, forcing resume (frozen ${Math.round(delta / 1000)}s)`);
					executeResume();
				}
			}, 1000);
		} else {
			executeResume();
		}
	}

	function executeResume() {
		if (sentinelId) {
			clearInterval(sentinelId);
			sentinelId = null;
		}
		watchdog.start();
		const elapsed = backgroundedAt > 0 ? Date.now() - backgroundedAt : 0;
		backgroundedAt = 0;
		if (elapsed > RESUME_THRESHOLD_MS && playerStore.view === 'video' && playerStore.currentVideo) {
			console.log(`[VideoPlayer] Resuming after ${Math.round(elapsed / 1000)}s`);
			engine.resume();
		}
	}

	function handleConnectivityChange(online: boolean) {
		if (online && playerStore.view === 'video' && playerStore.currentVideo) {
			console.log('[VideoPlayer] Back online → resuming');
			engine.resume();
		}
	}

	const connectionMonitor = new ConnectionMonitor(handleConnectivityChange, handleVisibilityChange);

	onMount(() => {
		const engineCleanup = engine.init(videoContainer!);
		const gestureCleanup = gesture.init(videoViewEl!);
		watchdog.start();

		playerStore.onShowList(() => engine.onViewHidden());
		playerStore.onProviderChange(() => engine.onProviderChange());
		playerStore.onReload(() => engine.forceReloadStream(playerStore.currentVideo!));

		return () => {
			engineCleanup();
			gestureCleanup();
			connectionMonitor.destroy();
			watchdog.stop();
			if (sentinelId) clearInterval(sentinelId);
		};
	});

	// Wake lock
	$effect(() => {
		engine.updateWakeLock(playerStore.view === 'video' && !!playerStore.currentVideo);
	});

	// Video removed from list
	$effect(() => {
		const filteredList = videoListStore.filteredVideos;
		untrack(() => {
			const cv = playerStore.currentVideo;
			if (!cv || playerStore.view !== 'video') return;
			if (!filteredList.some((v) => v.filename === cv.filename)) {
				const next = findAdjacentVideo(cv, filteredList, 1);
				if (next) {
					engine.forceProgressSave();
					playerStore.navigateVideo(next, getSavedTime(next), 1, videoListStore.selectedProvider);
					void fetchAndParsePlaylist(next);
				} else if (filteredList.length > 0) {
					const first = filteredList[0];
					engine.forceProgressSave();
					playerStore.navigateVideo(first, getSavedTime(first), 1, videoListStore.selectedProvider);
					void fetchAndParsePlaylist(first);
				} else {
					playerStore.showList();
				}
			}
		});
	});

	// Activate video when it changes
	$effect(() => {
		const cv = playerStore.currentVideo;
		if (!cv || playerStore.view !== 'video') return;
		engine.activateIfChanged(cv, playerStore.activePlayerIndex, playerStore.currentVideoStartTime);
	});

	// Preload adjacent
	$effect(() => {
		if (playerStore.view !== 'video') return;
		const activeIdx = playerStore.activePlayerIndex;
		const filteredList = videoListStore.filteredVideos;
		const cv = untrack(() => playerStore.currentVideo);
		if (!cv) return;
		engine.preloadForVideo(cv, activeIdx, filteredList);
	});
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
		></div>

		<div class="top-bar" class:ui-visible={playerStore.isUiVisible && !!video}>
			{#if video}
				<div class="streamer-name">{video.filename}</div>

				<ProgressBar {currentTime} duration={displayDuration} onseek={(t) => engine.handleSeek(t)} onseekdirect={(t) => engine.seekDirect(t)} />

				<PlayerControls {isMuted} getCurrentTime={() => engine.getCurrentTime()} ontoggleMute={() => engine.toggleMute()} />
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
