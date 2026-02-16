<script lang="ts">
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { VIDEO_TYPE } from '$lib/constants.js';
	import {
		saveCurrentVideo,
		createEditedVideo,
		returnToOriginals
	} from '$lib/services/videoActions.js';
	import { follow, unfollow, extractIdentifier, isFollowProvider } from '$lib/services/follow-api.js';

	let {
		isMuted,
		currentTime,
		ontoggleMute
	}: {
		isMuted: boolean;
		currentTime: number;
		ontoggleMute: () => void;
	} = $props();

	const video = $derived(playerStore.currentVideo);
	const segments = $derived(playerStore.segments);
	const isLive = $derived(video?.isLive === true);
	const isOriginal = $derived(video?.type === VIDEO_TYPE.ORIGINAL && !isLive);
	const isEdited = $derived(video?.type === VIDEO_TYPE.EDITED);
	const hasSegments = $derived(isOriginal && segments.length > 0);

	const provider = $derived(videoListStore.selectedProvider);
	const showFollow = $derived(isFollowProvider(provider));
	const identifier = $derived(video ? extractIdentifier(video.filename) : '');
	const isFollowing = $derived(videoListStore.followedIdentifiers.has(identifier));

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

	function handleFollow() {
		if (!identifier || !showFollow) return;
		if (isFollowing) {
			videoListStore.removeFollowedIdentifier(identifier);
			unfollow(provider, identifier).catch(() => {
				videoListStore.addFollowedIdentifier(identifier);
			});
		} else {
			videoListStore.addFollowedIdentifier(identifier);
			follow(provider, identifier).catch(() => {
				videoListStore.removeFollowedIdentifier(identifier);
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

			{#if showFollow}
				<button class:following={isFollowing} onclick={handleFollow}>
					{isFollowing ? '➖' : '➕'}
				</button>
			{/if}

			{#if isEdited}
				<button onclick={returnToOriginals}>🔄</button>
			{/if}

			{#if isOriginal}
				<button onclick={handleOkOrCut} disabled={hasSegments && segments.length % 2 !== 0}>
					{hasSegments ? '✂️' : '✅'}
				</button>
				<button onclick={() => playerStore.addSegment(currentTime)}>📍</button>
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
		padding: 8px 12px;
		font-size: 28px;
		min-width: 54px;
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

	button.following {
		border-color: #ff5e3a;
	}
</style>
