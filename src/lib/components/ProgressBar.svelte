<script lang="ts">
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { formatTimePrecise } from '$lib/utils/format.js';

	let {
		currentTime,
		duration,
		onseek
	}: {
		currentTime: number;
		duration: number;
		onseek: (time: number) => void;
	} = $props();

	let progressBar = $state<HTMLElement | null>(null);
	let isScrubbing = $state(false);

	const effectiveDuration = $derived(duration === Infinity ? 0 : isNaN(duration) ? 0 : duration);
	const percentage = $derived(effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0);
	const timeText = $derived(
		`${formatTimePrecise(currentTime)} / ${formatTimePrecise(effectiveDuration)}`
	);

	function handleScrub(e: PointerEvent) {
		if (!progressBar || effectiveDuration <= 0) return;
		const rect = progressBar.getBoundingClientRect();
		const position = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
		const newTime = effectiveDuration * (position / rect.width);
		onseek(newTime);
	}

	function onPointerDown(e: PointerEvent) {
		isScrubbing = true;
		handleScrub(e);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
	}

	function onPointerMove(e: PointerEvent) {
		if (isScrubbing) handleScrub(e);
	}

	function onPointerUp() {
		isScrubbing = false;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
	}
</script>

<div class="time-display-container">
	<span class="time-display">{timeText}</span>
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
	<div class="progress-fill" style="width: {percentage}%"></div>

	{#if effectiveDuration > 0}
		{#each playerStore.segments as point}
			<div class="segment-marker" style="left: {(point / effectiveDuration) * 100}%"></div>
		{/each}
	{/if}

	<div class="segment-text-container">
		{#each { length: Math.floor(playerStore.segments.length / 2) } as _, i}
			<div class="segment-row">
				<span>start: {formatTimePrecise(playerStore.segments[i * 2])}</span>
				{#if playerStore.segments[i * 2 + 1] !== undefined}
					<span>end: {formatTimePrecise(playerStore.segments[i * 2 + 1])}</span>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.time-display-container {
		text-align: center;
		margin-bottom: 8px;
	}

	.time-display {
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
</style>
