<script lang="ts">
	import { mount, unmount, onMount } from 'svelte';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { untrack } from 'svelte';
	import { VideoEngine } from '$lib/engine/VideoEngine.js';
	import { PlayerOverlayState } from '$lib/engine/PlayerOverlayState.svelte.js';
	import PlayerOverlay from './PlayerOverlay.svelte';
	import { GestureController } from '$lib/engine/GestureController.svelte.js';
	import { ConnectionMonitor } from '$lib/services/ConnectionMonitor.svelte.js';
	import { WatchdogService } from '$lib/services/WatchdogService.js';
	import { findAdjacentVideo } from '$lib/utils/navigation.js';
	import { fetchAndParsePlaylist } from '$lib/services/hls.js';
	import { logService } from '$lib/services/LogService.js';

	let videoViewEl = $state<HTMLElement | null>(null);
	let videoContainer = $state<HTMLElement | null>(null);

	const isVisible = $derived(playerStore.view === 'video');

	const emit = logService.emit;

	const overlayStates = [
		new PlayerOverlayState(),
		new PlayerOverlayState(),
		new PlayerOverlayState(),
	];
	let playlistSyncToken = 0;

	const engine = new VideoEngine({
		onLiveStatusChanged(filename, isLive) {
			emit('live-status-changed', { filename, isLive });
			videoListStore.updateVideoLive(filename, isLive);
		},
		onVideoRemoved(filename) {
			emit('video-removed', { filename });
			videoListStore.removeVideo(filename);
			const cv = playerStore.currentVideo;
			if (!cv) return;
			const filteredList = videoListStore.filteredVideos;
			const next = findAdjacentVideo(cv, filteredList, 1);
			if (next) {
				engine.forceProgressSave();
				playerStore.navigateVideo(next, 1);
			} else if (filteredList.length > 0) {
				const first = filteredList[0];
				engine.forceProgressSave();
				playerStore.navigateVideo(first, 1);
			} else {
				playerStore.showList();
			}
		}
	}, emit);

	async function syncPlaylistTruth(video: (typeof videoListStore.videos)[number]) {
		const token = ++playlistSyncToken;
		const playlistData = await fetchAndParsePlaylist(video);
		if (token !== playlistSyncToken || !playlistData) return;
		const totalDuration = playlistData.segments.reduce((sum, segment) => sum + segment.duration, 0);
		engine.applyPlaylistTruth(video.filename, {
			isLive: playlistData.isLive,
			totalDuration
		});
	}

	const doNavigate = (dir: 1 | -1) => {
		const cv = playerStore.currentVideo;
		if (!cv) return;
		const target = findAdjacentVideo(cv, videoListStore.filteredVideos, dir);
		if (target) {
			engine.forceProgressSave();
			playerStore.navigateVideo(target, dir);
			playerStore.updateScrollTarget(target);
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
		navPeekCancel: () => engine.navPeekCancel(),
		applyZoom: (s, x, y) => engine.applyZoom(s, x, y),
		resetZoom: () => engine.resetZoom()
	});

	const RESUME_THRESHOLD_MS = 3000;
	let backgroundedAt = 0;
	let sentinelId: ReturnType<typeof setInterval> | null = null;

	const watchdog = new WatchdogService();
	watchdog.setOnFreeze(() => {
		if (playerStore.view === 'video' && playerStore.currentVideo) {
			emit('watchdog-freeze-resume');
			engine.resume();
		}
	});

	function handleVisibilityChange(visible: boolean) {
		if (!visible) {
			backgroundedAt = Date.now();
			engine.forceProgressSave();
			watchdog.stop();
			if (sentinelId) clearInterval(sentinelId);
			let sentinelLast = Date.now();
			sentinelId = setInterval(() => {
				const now = Date.now();
				const delta = now - sentinelLast;
				sentinelLast = now;
				if (delta > 3000 && document.visibilityState === 'visible') {
					emit('sentinel-resume', { frozenSec: Math.round(delta / 1000) });
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
			emit('background-resume', { elapsedSec: Math.round(elapsed / 1000) });
			engine.resume();
		}
	}

	function handleConnectivityChange(online: boolean) {
		if (online && playerStore.view === 'video' && playerStore.currentVideo) {
			emit('online-resume');
			engine.resume();
		}
	}

	const connectionMonitor = new ConnectionMonitor(handleConnectivityChange, handleVisibilityChange);

	let mountedOverlays: ReturnType<typeof mount>[] = [];

	onMount(() => {
		const engineCleanup = engine.init(videoContainer!, overlayStates);
		const gestureCleanup = gesture.init(videoViewEl!);
		watchdog.start();

		for (let i = 0; i < 3; i++) {
			const wrapper = engine.getUnitWrapper(i);
			const instance = mount(PlayerOverlay, {
				target: wrapper,
				props: {
					overlay: overlayStates[i],
					onseek: (t: number) => engine.handleSeek(t),
					onseekdirect: (t: number) => engine.seekDirect(t),
					ontoggleMute: () => engine.toggleMute(),
					getCurrentTime: () => engine.getCurrentTime(),
				}
			});
			mountedOverlays.push(instance);
		}

		playerStore.onShowList(() => engine.onViewHidden());
		playerStore.onProviderChange(() => engine.onProviderChange());
		playerStore.onReload(() => engine.forceReloadStream(playerStore.currentVideo!));

		return () => {
			for (const instance of mountedOverlays) {
				unmount(instance);
			}
			mountedOverlays = [];
			engineCleanup();
			gestureCleanup();
			connectionMonitor.destroy();
			watchdog.stop();
			if (sentinelId) clearInterval(sentinelId);
		};
	});

	$effect(() => {
		engine.updateWakeLock(playerStore.view === 'video' && !!playerStore.currentVideo);
	});

	$effect(() => {
		const filteredList = videoListStore.filteredVideos;
		untrack(() => {
			const cv = playerStore.currentVideo;
			if (!cv || playerStore.view !== 'video') return;
			if (!filteredList.some((v) => v.filename === cv.filename)) {
				const next = findAdjacentVideo(cv, filteredList, 1);
				if (next) {
					engine.forceProgressSave();
					playerStore.navigateVideo(next, 1);
				} else if (filteredList.length > 0) {
					const first = filteredList[0];
					engine.forceProgressSave();
					playerStore.navigateVideo(first, 1);
				} else {
					playerStore.showList();
				}
			}
		});
	});

	$effect(() => {
		if (playerStore.view === 'video') return;
		playlistSyncToken += 1;
	});

	$effect(() => {
		const cv = playerStore.currentVideo;
		if (!cv || playerStore.view !== 'video') return;
		void syncPlaylistTruth(cv);
	});

	$effect(() => {
		const cv = playerStore.currentVideo;
		if (!cv || playerStore.view !== 'video') return;
		engine.activateIfChanged(cv, playerStore.activePlayerIndex, playerStore.startTimeOverride);
	});

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
	class:swipe-active={gesture.isSwiping}
	class:swipe-animating={gesture.swipeAnimating}
	style:transform={gesture.isSwiping || gesture.swipeAnimating
		? `translateX(${gesture.swipeProgress * 100}%)`
		: null}
	role="application"
	bind:this={videoViewEl}
>
	<div class="video-container" bind:this={videoContainer}></div>
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

	.video-container :global(.player-unit) {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background-color: #000;
	}

	.video-container :global(.active-unit) {
		z-index: 5;
		opacity: 1;
	}

	.video-container :global(.background-unit) {
		z-index: 1;
		opacity: 0;
	}

	.video-container :global(.player-unit video) {
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

	.video-view.swipe-active {
		box-shadow: -10px 0 30px rgba(0, 0, 0, 0.3);
	}

	.video-view.swipe-animating {
		transition: transform 250ms ease-out;
	}
</style>
