<script lang="ts">
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { followStreamer, unfollowStreamer } from '$lib/services/tl-api.js';

	const video = $derived(playerStore.currentVideo);
	const streamer = $derived(video ? videoListStore.getStreamer(video.filename) : undefined);
	const isFollowing = $derived(streamer?.isFollowing ?? false);

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
</script>

{#if streamer}
	<div class="tl-controls">
		<button class="tl-btn" onclick={ontoggleMute}>
			{isMuted ? '🔇' : '🔊'}
		</button>
		<button class="tl-btn" class:following={isFollowing} onclick={handleFollow}>
			{isFollowing ? '➖' : '➕'}
		</button>
		<button class="tl-btn block-btn" class:confirm={blockConfirm} onclick={handleBlock}>
			{blockConfirm ? '❓' : '🚫'}
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
