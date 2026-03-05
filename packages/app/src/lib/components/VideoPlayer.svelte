<script lang="ts">
	import { onMount } from 'svelte';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { untrack } from 'svelte';
	import { VideoEngine } from '$lib/engine/VideoEngine.js';

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
		getPlayerStore: () => playerStore,
		getVideoListStore: () => videoListStore
	});

	onMount(() => {
		const cleanup = engine.init(videoViewEl!, videoContainer!);
		return cleanup;
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
				engine.handleVideoGone();
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

				<ProgressBar {currentTime} duration={displayDuration} onseek={(t) => engine.handleSeek(t)} />

				<PlayerControls {isMuted} {currentTime} ontoggleMute={() => engine.toggleMute()} />
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
