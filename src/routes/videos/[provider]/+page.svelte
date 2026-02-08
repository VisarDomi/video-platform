<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { PROVIDERS, DEFAULT_PROVIDER, STORAGE_KEYS } from '$lib/constants.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { fetchVideos } from '$lib/services/api.js';
	import { filterVideos } from '$lib/utils/filter.js';
	import ProviderSelector from '$lib/components/ProviderSelector.svelte';
	import VideoItem from '$lib/components/VideoItem.svelte';
	import VideoPlayer from '$lib/components/VideoPlayer.svelte';
	import { fetchAndParsePlaylist } from '$lib/services/hls.js';

	const MIN_LIST_ITEMS = 100;

	let searchInput = $state<HTMLInputElement | null>(null);
	let lastScrollY = $state(0);
	let searchHidden = $state(false);

	const provider = $derived(page.params.provider);

	const filteredVideos = $derived(
		filterVideos(videoListStore.videos, videoListStore.filter)
	);

	// Validate provider and load videos when it changes
	$effect(() => {
		const p = provider ?? DEFAULT_PROVIDER;
		if (!(PROVIDERS as readonly string[]).includes(p)) {
			goto(`/videos/${DEFAULT_PROVIDER}`, { replaceState: true });
			return;
		}
		videoListStore.initialize(p);
		playerStore.initialize(p);
		loadVideos(p);
	});

	async function loadVideos(p: string) {
		const videos = await fetchVideos(p);
		videoListStore.setVideos(videos);
	}

	// Update title reactively
	$effect(() => {
		const cv = playerStore.currentVideo;
		const p = videoListStore.selectedProvider;
		if (playerStore.view === 'video' && cv) {
			document.title = `${cv.filename} - ${p} - Video Editor`;
		} else {
			document.title = `${p} - Video Editor`;
		}
	});

	function handleVideoClick(video: typeof videoListStore.videos[number]) {
		const saved = localStorage.getItem(`${STORAGE_KEYS.PROGRESS_PREFIX}${video.filename}`);
		const startTime = saved && parseFloat(saved) > 0 ? Math.round(parseFloat(saved)) : 0;
		playerStore.playVideo(video, startTime, videoListStore.selectedProvider);
		void fetchAndParsePlaylist(video);
	}

	function handleScroll() {
		if (document.activeElement === searchInput) return;

		const currentScrollY = window.scrollY;
		if (Math.abs(currentScrollY - lastScrollY) < 10) return;

		if (currentScrollY > lastScrollY && currentScrollY > 50) {
			searchHidden = true;
		} else {
			searchHidden = false;
		}
		lastScrollY = currentScrollY < 0 ? 0 : currentScrollY;
	}

	function clearFilter() {
		videoListStore.setFilter('');
		if (searchInput) {
			searchInput.value = '';
			searchInput.blur();
		}
	}

	function isActiveVideo(video: typeof videoListStore.videos[number]): boolean {
		const active = playerStore.currentVideo || playerStore.lastPlayedVideo;
		if (!active) return false;
		return video.filename === active.filename && video.type === active.type;
	}
</script>

<svelte:window onscroll={handleScroll} />

<div class="search-container" class:hidden={searchHidden}>
	<ProviderSelector />
	<div class="search-row">
		<input
			bind:this={searchInput}
			type="text"
			placeholder="Filter (regex)..."
			value={videoListStore.filter}
			oninput={(e) => videoListStore.setFilter(e.currentTarget.value)}
		/>
		{#if videoListStore.filter}
			<button class="clear-btn" onclick={clearFilter}>&times;</button>
		{/if}
	</div>
</div>

<div class="list-container">
	{#if videoListStore.isLoading}
		<p class="info-message">Loading...</p>
	{:else if filteredVideos.length === 0}
		<p class="info-message">No videos found.</p>
		{#each { length: MIN_LIST_ITEMS - 1 } as _}
			<div class="empty-item"></div>
		{/each}
	{:else}
		{#each filteredVideos as video (video.filename + video.type)}
			<VideoItem
				{video}
				isActive={isActiveVideo(video)}
				isLastActioned={playerStore.lastActionedVideoFilename === video.filename}
				onclick={() => handleVideoClick(video)}
			/>
		{/each}
		{#each { length: Math.max(0, MIN_LIST_ITEMS - filteredVideos.length) } as _}
			<div class="empty-item"></div>
		{/each}
	{/if}
</div>

<VideoPlayer />

<style>
	.search-container {
		position: fixed;
		top: 20%;
		left: 10px;
		right: 10px;
		z-index: 100;
		transform: translateY(-50%);
		background-color: rgba(20, 20, 20, 0.7);
		border: 1px solid #444;
		display: flex;
		flex-direction: column;
		align-items: center;
		border-radius: 12px;
		padding: 5px;
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		opacity: 1;
		transition: opacity 0.3s ease, transform 0.3s ease;
	}

	.search-container.hidden {
		opacity: 0;
		transform: translateY(-1500%);
		pointer-events: none;
	}

	.search-row {
		display: flex;
		width: 100%;
		align-items: center;
	}

	input {
		flex-grow: 1;
		padding: 10px;
		font-size: 16px;
		background-color: transparent;
		border: none;
		color: white;
		outline: none;
	}

	.clear-btn {
		background: none;
		border: none;
		color: #aaa;
		cursor: pointer;
		font-size: 18px;
		line-height: 1;
		padding: 0 10px;
	}

	.list-container {
		padding-top: 0;
	}

	.info-message {
		text-align: center;
		padding: 40px;
		font-style: italic;
		color: #888;
	}

	.empty-item {
		height: 52px;
		border-bottom: 1px solid #333;
	}
</style>
