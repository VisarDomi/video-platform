<script lang="ts">
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { followStreamer, unfollowStreamer } from '$lib/services/tl-api.js';
	import { addToList, removeFromList } from '$lib/services/list-api.js';

	const video = $derived(playerStore.currentVideo);
	const streamer = $derived(video ? videoListStore.getStreamer(video.filename) : undefined);
	const isFollowing = $derived(streamer?.isFollowing ?? false);
	const identifier = $derived(video?.filename ?? '');
	const isInList = $derived(videoListStore.listIdentifiers.has(identifier));

	let {
		isMuted,
		ontoggleMute,
		onblock
	}: {
		isMuted: boolean;
		ontoggleMute: () => void;
		onblock: (alias: string, streamerId: string) => void;
	} = $props();

	let blockConfirm = $state(false);

	function handleFollow() {
		if (!streamer) return;
		const id = streamer.streamerId;
		const wasFollowing = streamer.isFollowing;

		// Optimistic update
		const updated = { ...streamer, isFollowing: !wasFollowing };
		videoListStore.streamerMap = new Map(videoListStore.streamerMap).set(updated.alias, updated);

		const action = wasFollowing ? unfollowStreamer(id) : followStreamer(id);
		action.catch(() => {
			// Revert on failure
			const reverted = { ...updated, isFollowing: wasFollowing };
			videoListStore.streamerMap = new Map(videoListStore.streamerMap).set(
				reverted.alias,
				reverted
			);
		});
	}

	function handleBlock() {
		if (!streamer) return;
		if (!blockConfirm) {
			blockConfirm = true;
			return;
		}
		blockConfirm = false;
		onblock(streamer.alias, streamer.streamerId);
	}

	function handleListToggle() {
		if (!identifier) return;
		if (isInList) {
			videoListStore.removeListIdentifier(identifier);
			removeFromList('tl', identifier).catch(() => {
				videoListStore.addListIdentifier(identifier);
			});
		} else {
			videoListStore.addListIdentifier(identifier);
			addToList('tl', identifier).catch(() => {
				videoListStore.removeListIdentifier(identifier);
			});
		}
	}
</script>

{#if streamer}
	<div class="tl-controls">
		<button class="tl-btn" onclick={ontoggleMute}>
			{isMuted ? '🔇' : '🔊'}
		</button>
		<button class="tl-btn" class:following={isFollowing} onclick={handleFollow}>
			{isFollowing ? '❤️' : '🤍'}
		</button>
		<button class="tl-btn block-btn" class:confirm={blockConfirm} onclick={handleBlock}>
			{blockConfirm ? '❓' : '🚫'}
		</button>
		<button class="tl-btn" class:list-add={!isInList} class:list-remove={isInList} onclick={handleListToggle}>
			{isInList ? '➖' : '➕'}
		</button>
	</div>
{/if}

<style>
	.tl-controls {
		display: flex;
		gap: 10px;
	}

	.tl-btn {
		padding: 12px 18px;
		font-size: 36px;
		background-color: rgba(0, 0, 0, 0.6);
		color: white;
		border: 1px solid white;
		border-radius: 8px;
		cursor: pointer;
		min-width: 70px;
		line-height: 1;
		text-align: center;
	}

	.tl-btn.following {
		border-color: #ff5e3a;
	}

	.tl-btn.confirm {
		border-color: #ff0;
		background-color: rgba(100, 100, 0, 0.6);
	}

	.tl-btn.list-add {
		border-color: #34c759;
	}

	.tl-btn.list-remove {
		border-color: #ff5e3a;
	}

	@media (hover: hover) and (pointer: fine) {
		.tl-btn:hover {
			background-color: #ff5e3a;
			border-color: #ff5e3a;
		}
	}

	.tl-btn:active {
		background-color: #ff5e3a;
		border-color: #ff5e3a;
	}
</style>
