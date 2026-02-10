<script lang="ts">
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { PROVIDERS, DEFAULT_PROVIDER, STORAGE_KEYS } from '$lib/constants.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { fetchVideos } from '$lib/services/api.js';
	import { startSync, stopSync } from '$lib/services/sync.js';
	import { filterByAliases } from '$lib/utils/filter.js';
	import AliasSelector from '$lib/components/AliasSelector.svelte';
	import VideoItem from '$lib/components/VideoItem.svelte';
	import VideoPlayer from '$lib/components/VideoPlayer.svelte';
	import { fetchAndParsePlaylist } from '$lib/services/hls.js';

	const MIN_LIST_ITEMS = 100;

	let listContainer = $state<HTMLElement | null>(null);
	let lastScrollY = 0;
	let searchHidden = $state(false);

	const provider = $derived(page.params.provider);

	const filteredVideos = $derived(
		filterByAliases(videoListStore.videos, videoListStore.selectedAliases)
	);

	// Validate provider and load videos when it changes
	$effect(() => {
		const p = provider ?? DEFAULT_PROVIDER;
		if (!(PROVIDERS as readonly string[]).includes(p)) {
			goto(`/videos/${DEFAULT_PROVIDER}`, { replaceState: true });
			return;
		}
		stopSync();
		videoListStore.initialize(p);
		videoListStore.clearAliases();
		playerStore.initialize(p);
		loadVideos(p);
	});

	async function loadVideos(p: string) {
		const videos = await fetchVideos(p);
		videoListStore.setVideos(videos);
		startSync(p);
		await tick();
		const saved = localStorage.getItem(STORAGE_KEYS.SCROLL_PREFIX + p);
		window.scrollTo(0, saved ? parseFloat(saved) : 0);
	}

	function scrollToActiveVideo() {
		if (!listContainer) return;
		const target =
			listContainer.querySelector('.last-actioned') ||
			listContainer.querySelector('.current-video');
		if (target) {
			target.scrollIntoView({ block: 'center', behavior: 'auto' });
		}
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

	function handleVideoClick(video: (typeof videoListStore.videos)[number]) {
		const saved = localStorage.getItem(`${STORAGE_KEYS.PROGRESS_PREFIX}${video.filename}`);
		const startTime = saved && parseFloat(saved) > 0 ? Math.round(parseFloat(saved)) : 0;
		playerStore.playVideo(video, startTime, videoListStore.selectedProvider);
		void fetchAndParsePlaylist(video);
	}

	function handleScroll() {
		if (playerStore.view === 'video') return;

		const currentScrollY = window.scrollY;
		if (Math.abs(currentScrollY - lastScrollY) < 10) return;

		if (currentScrollY > lastScrollY && currentScrollY > 50) {
			searchHidden = true;
		} else {
			searchHidden = false;
		}
		lastScrollY = currentScrollY < 0 ? 0 : currentScrollY;

		const p = videoListStore.selectedProvider;
		if (p && playerStore.view === 'list' && !videoListStore.isLoading) {
			localStorage.setItem(STORAGE_KEYS.SCROLL_PREFIX + p, String(Math.round(currentScrollY)));
		}
	}

	// Hide search when entering video view, reset and scroll when returning to list
	$effect(() => {
		if (playerStore.view === 'video') {
			searchHidden = true;
		} else {
			searchHidden = false;
			lastScrollY = 0;
			tick().then(scrollToActiveVideo);
		}
	});

	function isActiveVideo(video: (typeof videoListStore.videos)[number]): boolean {
		const active = playerStore.currentVideo || playerStore.lastPlayedVideo;
		if (!active) return false;
		return video.filename === active.filename && video.type === active.type;
	}
	// Swipe to switch provider
	const SWIPE_THRESHOLD = 80;
	let swipeStartX = 0;
	let swipeStartY = 0;

	function handleTouchStart(e: TouchEvent) {
		if (playerStore.view !== 'list') return;
		swipeStartX = e.touches[0].clientX;
		swipeStartY = e.touches[0].clientY;
	}

	function handleTouchEnd(e: TouchEvent) {
		if (playerStore.view !== 'list') return;
		const touch = e.changedTouches[0];
		const dx = touch.clientX - swipeStartX;
		const dy = touch.clientY - swipeStartY;
		if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 2) {
			switchProvider(dx < 0 ? 1 : -1);
		}
	}

	function switchProvider(direction: 1 | -1) {
		const currentIdx = (PROVIDERS as readonly string[]).indexOf(videoListStore.selectedProvider);
		const newIdx = currentIdx + direction;
		if (newIdx < 0 || newIdx >= PROVIDERS.length) return;
		const newProvider = PROVIDERS[newIdx];
		videoListStore.setProvider(newProvider);
		goto(`/videos/${newProvider}`, { replaceState: true });
	}
</script>

<svelte:window
	onscroll={handleScroll}
	ontouchstart={handleTouchStart}
	ontouchend={handleTouchEnd}
/>

<div class="search-container" class:hidden={searchHidden}>
	<AliasSelector />
</div>

<div class="list-container" bind:this={listContainer}>
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
		transition:
			opacity 0.3s ease,
			transform 0.3s ease;
	}

	.search-container.hidden {
		opacity: 0;
		transform: translateY(-1500%);
		pointer-events: none;
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
