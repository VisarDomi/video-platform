<script lang="ts">
	import type { Video } from '$lib/types.js';
	import { VIDEO_TYPE, BPS_ESTIMATE } from '$lib/constants.js';
	import { formatDuration, formatSize } from '$lib/utils/format.js';

	let {
		video,
		isActive,
		isLastActioned,
		onclick,
		streamerInfo
	}: {
		video: Video;
		isActive: boolean;
		isLastActioned: boolean;
		onclick: () => void;
		streamerInfo?: { firstName: string; isFollowing: boolean; parentAlias?: string };
	} = $props();

	const sizeBytes = $derived(video.duration * BPS_ESTIMATE);
	const isLarge = $derived(sizeBytes > 350 * 1024 * 1024);
	const isEdited = $derived(video.type === VIDEO_TYPE.EDITED);
	const tlLabel = $derived(
		streamerInfo
			? streamerInfo.parentAlias
				? `Co-streamer of ${streamerInfo.parentAlias}`
				: streamerInfo.isFollowing
					? 'Following'
					: 'Recommended'
			: null
	);
</script>

<button
	class="list-item"
	class:current-video={isActive}
	class:last-actioned={isLastActioned}
	class:live={video.isLive}
	class:edited={isEdited}
	{onclick}
>
	<span class="name"
		>{video.filename}{#if streamerInfo}
			{streamerInfo.firstName}{/if}</span
	>
	<span class="meta">
		{#if tlLabel}
			<span class="tl-label" class:following={streamerInfo?.isFollowing}>{tlLabel}</span>
		{:else}
			<span class="duration">{formatDuration(video.duration)}</span>
			<span class="size" class:bold={isLarge}>{formatSize(sizeBytes)}</span>
		{/if}
	</span>
</button>

<style>
	.list-item {
		padding: 8px 15px;
		border-bottom: 1px solid #333;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		justify-content: center;
		height: 52px;
		box-sizing: border-box;
		overflow: hidden;
		width: 100%;
		background: transparent;
		border-left: none;
		border-right: none;
		border-top: none;
		color: #fff;
		text-align: left;
		font-family: inherit;
	}

	.list-item:hover {
		background-color: #2a2a2a;
	}

	.list-item.current-video {
		background-color: #0e0e0e;
		font-weight: bold;
	}

	@media (hover: hover) and (pointer: fine) {
		.list-item.current-video:hover {
			background-color: #ff7a5c;
		}
	}

	.list-item.last-actioned .name {
		font-weight: bold;
	}

	.list-item.live .name {
		color: #ff6b6b;
	}

	.list-item.edited .name {
		color: #f0a050;
	}

	.name {
		font-size: 16px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1.3;
	}

	.meta {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 2px;
		line-height: 1.2;
		gap: 8px;
	}

	.duration,
	.size {
		font-size: 13px;
		color: #aaa;
		font-family: 'Courier New', Courier, monospace;
		flex-shrink: 0;
	}

	.size.bold {
		font-weight: bold;
		color: #e0e0e0;
	}

	.tl-label {
		font-size: 13px;
		color: #aaa;
	}

	.tl-label.following {
		color: #4cd137;
	}
</style>
