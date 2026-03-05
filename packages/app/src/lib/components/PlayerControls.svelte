<script lang="ts">
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { VIDEO_TYPE } from '$lib/constants.js';
	import {
		saveCurrentVideo,
		createEditedVideo,
		returnToOriginals
	} from '$lib/services/videoActions.js';
	import { extractIdentifier } from '$lib/services/follow-api.js';
	import { addToList, removeFromList, isListProvider } from '$lib/services/list-api.js';

	let {
		isMuted,
		getCurrentTime,
		ontoggleMute
	}: {
		isMuted: boolean;
		getCurrentTime: () => number;
		ontoggleMute: () => void;
	} = $props();

	const video = $derived(playerStore.currentVideo);
	const segments = $derived(playerStore.segments);
	const isLive = $derived(video?.isLive === true);
	const isOriginal = $derived(video?.type === VIDEO_TYPE.ORIGINAL && !isLive);
	const isEdited = $derived(video?.type === VIDEO_TYPE.EDITED);
	const hasSegments = $derived(isOriginal && segments.length > 0);

	const provider = $derived(videoListStore.selectedProvider);
	const showListButton = $derived(isListProvider(provider));
	const identifier = $derived(video ? extractIdentifier(video.filename) : '');
	const isInList = $derived(videoListStore.listIdentifiers.has(identifier));

	function handleMuteOrUndo() {
		if (hasSegments) {
			playerStore.removeLastSegment();
		} else {
			ontoggleMute();
		}
	}

	function handleOkOrCut() {
		if (hasSegments) {
			void createEditedVideo();
		} else {
			saveCurrentVideo();
		}
	}

	function handleListToggle() {
		if (!identifier || !showListButton) return;
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

{#if video}
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

<style>
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
