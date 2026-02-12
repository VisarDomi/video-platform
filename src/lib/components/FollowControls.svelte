<script lang="ts">
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { follow, unfollow, extractIdentifier, isFollowProvider } from '$lib/services/follow-api.js';

	let {
		isMuted,
		ontoggleMute
	}: {
		isMuted: boolean;
		ontoggleMute: () => void;
	} = $props();

	const video = $derived(playerStore.currentVideo);
	const identifier = $derived(video ? extractIdentifier(video.filename) : '');
	const provider = $derived(videoListStore.selectedProvider);
	const isFollowing = $derived(videoListStore.followedIdentifiers.has(identifier));

	function handleFollow() {
		if (!identifier || !isFollowProvider(provider)) return;

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
	<div class="follow-controls">
		<button class="ctrl-btn" onclick={ontoggleMute}>
			{isMuted ? '🔇' : '🔊'}
		</button>
		<button class="ctrl-btn" class:following={isFollowing} onclick={handleFollow}>
			{isFollowing ? '➖' : '➕'}
		</button>
	</div>
{/if}

<style>
	.follow-controls {
		display: flex;
		gap: 10px;
	}

	.ctrl-btn {
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

	.ctrl-btn.following {
		border-color: #ff5e3a;
	}

	@media (hover: hover) and (pointer: fine) {
		.ctrl-btn:hover {
			background-color: #ff5e3a;
			border-color: #ff5e3a;
		}
	}

	.ctrl-btn:active {
		background-color: #ff5e3a;
		border-color: #ff5e3a;
	}
</style>
