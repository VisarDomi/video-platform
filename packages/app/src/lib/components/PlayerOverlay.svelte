<script lang="ts">
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { VIDEO_TYPE } from '$lib/constants.js';
	import { formatTimePrecise } from '$lib/utils/format.js';
	import {
		saveCurrentVideo,
		createEditedVideo,
		returnToOriginals
	} from '$lib/services/videoActions.js';
	import { addToList, removeFromList, isListProvider, extractIdentifier } from '$lib/services/list-api.js';
	import type { PlayerOverlayState } from '$lib/engine/PlayerOverlayState.svelte.js';

	let {
		overlay,
		onseek,
		onseekdirect,
		ontoggleMute,
		getCurrentTime
	}: {
		overlay: PlayerOverlayState;
		onseek: (time: number) => void;
		onseekdirect: (time: number) => void;
		ontoggleMute: () => void;
		getCurrentTime: () => number;
	} = $props();

	const video = $derived(overlay.video);
	const currentTime = $derived(overlay.currentTime);
	const duration = $derived(overlay.duration);
	const seekableEnd = $derived(overlay.seekableEnd);
	const currentSegmentName = $derived(overlay.currentSegmentName);
	const playbackIsLive = $derived(overlay.isLive);
	const isMuted = $derived(overlay.isMuted);
	const isActive = $derived(overlay.isActive);
	const displayDuration = $derived(
		duration === Infinity && seekableEnd > 0 ? seekableEnd : duration
	);

	// Progress bar
	const effectiveDuration = $derived(displayDuration === Infinity ? 0 : isNaN(displayDuration) ? 0 : displayDuration);
	const percentage = $derived(effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0);
	const timeText = $derived(
		`${formatTimePrecise(currentTime)} / ${formatTimePrecise(effectiveDuration)}`
	);

	// Controls
	const segments = $derived(isActive ? playerStore.segments : []);
	const isLive = $derived(playbackIsLive);
	const isOriginal = $derived(video?.type === VIDEO_TYPE.ORIGINAL && !isLive);
	const isEdited = $derived(video?.type === VIDEO_TYPE.EDITED);
	const hasSegments = $derived(isOriginal && segments.length > 0);

	const provider = $derived(videoListStore.selectedProvider);
	const showListButton = $derived(isActive && isListProvider(provider) && !videoListStore.listLoading);
	const identifier = $derived(video ? extractIdentifier(video.filename) : '');
	const isInList = $derived(videoListStore.listIdentifiers.has(identifier));

	// Progress bar scrubbing
	let progressBar = $state<HTMLElement | null>(null);
	let isScrubbing = $state(false);
	let cachedRect: DOMRect | null = null;
	let lastScrubTime = 0;
	let rafId = 0;
	let pendingScrubX = 0;

	function calcTimeFromX(clientX: number): number {
		if (!cachedRect || effectiveDuration <= 0) return 0;
		const position = Math.max(0, Math.min(clientX - cachedRect.left, cachedRect.width));
		return effectiveDuration * (position / cachedRect.width);
	}

	function onPointerDown(e: PointerEvent) {
		if (!isActive) return;
		isScrubbing = true;
		cachedRect = progressBar!.getBoundingClientRect();
		const time = calcTimeFromX(e.clientX);
		onseek(time);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
	}

	function onPointerMove(e: PointerEvent) {
		if (!isScrubbing) return;
		pendingScrubX = e.clientX;
		if (!rafId) {
			rafId = requestAnimationFrame(flushScrub);
		}
	}

	function flushScrub() {
		rafId = 0;
		if (!isScrubbing) return;
		const time = calcTimeFromX(pendingScrubX);
		onseekdirect(time);
		lastScrubTime = time;
	}

	function onPointerUp() {
		if (rafId) {
			cancelAnimationFrame(rafId);
			rafId = 0;
		}
		if (isScrubbing && lastScrubTime > 0) {
			onseek(lastScrubTime);
		}
		isScrubbing = false;
		lastScrubTime = 0;
		cachedRect = null;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
	}

	// Control handlers
	function handleMuteOrUndo() {
		if (hasSegments) {
			playerStore.removeLastSegment();
		} else {
			ontoggleMute();
		}
	}

	function handleOkOrCut() {
		if (hasSegments) {
			void createEditedVideo(effectiveDuration);
		} else {
			saveCurrentVideo();
		}
	}

	function handleListToggle() {
		if (!identifier || !isListProvider(provider)) return;
		if (isInList) {
			videoListStore.removeListIdentifier(identifier);
			removeFromList(provider, identifier).catch(() => {
				videoListStore.addListIdentifier(identifier);
			});
		} else {
			videoListStore.addListIdentifier(identifier);
			addToList(provider, identifier).catch(() => {
				videoListStore.removeListIdentifier(identifier);
			});
		}
	}
</script>

<div class="overlay-top-bar" class:ui-visible={playerStore.isUiVisible && !!video}>
	{#if video}
		<div class="streamer-name">{video.filename}</div>

		<div class="time-display-container">
			<span class="time-display">{timeText}</span>
			{#if currentSegmentName}
				<span class="segment-display">{currentSegmentName}</span>
			{/if}
		</div>

		<div
			class="progress-bar"
			role="slider"
			aria-valuenow={currentTime}
			aria-valuemin={0}
			aria-valuemax={effectiveDuration}
			tabindex="-1"
			bind:this={progressBar}
			onpointerdown={onPointerDown}
		>
			<div class="progress-fill" style:width="{percentage}%"></div>

			{#if effectiveDuration > 0}
				{#each segments as point}
					<div class="segment-marker" style:left="{(point / effectiveDuration) * 100}%"></div>
				{/each}
			{/if}

			<div class="segment-text-container">
				{#each { length: Math.ceil(segments.length / 2) } as _, i}
					<div class="segment-row">
						<span>start: {formatTimePrecise(segments[i * 2])}</span>
						{#if segments[i * 2 + 1] !== undefined}
							<span>end: {formatTimePrecise(segments[i * 2 + 1])}</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<div class="controls">
			<div class="buttons">
				<button onclick={handleMuteOrUndo}>
					{#if hasSegments}
						↪️
					{:else}
						{isMuted ? '🔇' : '🔊'}
					{/if}
				</button>

				{#if showListButton}
					<button class:list-add={!isInList} class:list-remove={isInList} onclick={handleListToggle}>
						{isInList ? '➖' : '➕'}
					</button>
				{/if}

				{#if isEdited}
					<button onclick={returnToOriginals}>🔄</button>
				{/if}

				{#if isOriginal}
					<button onclick={handleOkOrCut} disabled={hasSegments && segments.length % 2 !== 0}>
						{hasSegments ? '✂️' : '✅'}
					</button>
					<button onclick={() => playerStore.addSegment(getCurrentTime())}>📍</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.overlay-top-bar {
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

	.overlay-top-bar.ui-visible {
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

	.time-display-container {
		text-align: center;
		margin-bottom: 8px;
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.time-display,
	.segment-display {
		display: inline-block;
		background-color: rgba(0, 0, 0, 0.5);
		padding: 4px 12px;
		border-radius: 6px;
		font-family: 'Courier New', Courier, monospace;
		font-size: 18px;
		font-weight: bold;
		text-shadow: 1px 1px 2px black;
		color: #f0f0f0;
	}

	.segment-display {
		color: #ffd166;
		font-size: 9px;
	}

	.progress-bar {
		width: 100%;
		height: 100px;
		background-color: rgba(255, 255, 255, 0.3);
		border-radius: 10px;
		position: relative;
		overflow: hidden;
		cursor: pointer;
		margin-bottom: 10px;
		touch-action: manipulation;
	}

	.progress-fill {
		width: 0;
		height: 100%;
		background-color: #ff5e3a;
		border-radius: 10px;
		position: absolute;
		top: 0;
		left: 0;
	}

	.segment-marker {
		position: absolute;
		top: 0;
		width: 4px;
		height: 100%;
		background-color: white;
		transform: translateX(-50%);
		z-index: 3;
	}

	.segment-text-container {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		padding: 8px 15px;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		z-index: 2;
		pointer-events: none;
		font-family: 'Courier New', Courier, monospace;
		color: white;
		text-shadow: 2px 2px 4px black;
		font-weight: bold;
		font-size: 16px;
	}

	.segment-row {
		display: flex;
		justify-content: space-between;
		width: 100%;
	}

	.controls {
		display: flex;
		align-items: center;
	}

	.buttons {
		display: flex;
		gap: 10px;
	}

	button {
		padding: 12px 18px;
		font-size: 36px;
		min-width: 70px;
		background-color: rgba(0, 0, 0, 0.6);
		color: white;
		border: 1px solid white;
		border-radius: 8px;
		cursor: pointer;
		line-height: 1;
		text-align: center;
	}

	@media (hover: hover) and (pointer: fine) {
		button:not(:disabled):hover {
			background-color: #ff5e3a;
			border-color: #ff5e3a;
		}
	}

	button:not(:disabled):active {
		background-color: #ff5e3a;
		border-color: #ff5e3a;
	}

	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
		background-color: rgba(0, 0, 0, 0.6);
		border-color: #888;
		color: #888;
	}

	button.list-add {
		border-color: #34c759;
	}

	button.list-remove {
		border-color: #ff5e3a;
	}
</style>
