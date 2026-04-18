<script lang="ts">
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { PROVIDERS, DEFAULT_PROVIDER, STORAGE_KEYS } from '$lib/constants.js';
	import { swipeable } from '$lib/actions/swipeable.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { fetchVideos } from '$lib/services/api.js';
	import { startSync, stopSync } from '$lib/services/sync.js';
	import AliasSelector from '$lib/components/AliasSelector.svelte';
	import VideoItem from '$lib/components/VideoItem.svelte';
	import VideoPlayer from '$lib/components/VideoPlayer.svelte';
	import { fetchListIdentifiers, isListProvider } from '$lib/services/list-api.js';
	import { VIDEO_TYPE, API } from '$lib/constants.js';

	const ITEM_HEIGHT = 52;
	const SCROLL_BUFFER = 10;

	let lastScrollY = 0;
	let searchHidden = $state(false);
	let scrollY = $state(0);

	const provider = $derived(page.params.provider);

	const filteredVideos = $derived(videoListStore.filteredVideos);

	const totalHeight = $derived(filteredVideos.length * ITEM_HEIGHT);
	const startIdx = $derived(Math.max(0, Math.floor(scrollY / ITEM_HEIGHT) - SCROLL_BUFFER));
	const endIdx = $derived(
		Math.min(
			filteredVideos.length,
			Math.ceil(
				(scrollY + (typeof window !== 'undefined' ? window.innerHeight : 800)) / ITEM_HEIGHT
			) + SCROLL_BUFFER
		)
	);
	const visibleVideos = $derived(filteredVideos.slice(startIdx, endIdx));
	const offsetY = $derived(startIdx * ITEM_HEIGHT);

	let previousProvider: string | null = null;

	$effect(() => {
		const p = provider ?? DEFAULT_PROVIDER;
		if (!(PROVIDERS as readonly string[]).includes(p)) {
			goto(`/videos/${DEFAULT_PROVIDER}`, { replaceState: true });
			return;
		}

		stopSync();
		playerStore.triggerProviderChange();

		videoListStore.initialize(p);
		playerStore.initialize(p);
		loadVideos(p);

		previousProvider = p;
	});

	async function loadVideos(p: string) {
		const epoch = videoListStore.epoch;
		const videos = await fetchVideos(p);
		if (videoListStore.epoch !== epoch) return;
		videoListStore.setVideos(videos);
		if (isListProvider(p)) {
			fetchListIdentifiers(p).then((ids) => {
				if (videoListStore.epoch !== epoch) return;
				videoListStore.setListIdentifiers(ids);
			});
		}
		startSync(p);
		await tick();
		const saved = localStorage.getItem(STORAGE_KEYS.SCROLL_PREFIX + p);
		window.scrollTo(0, saved ? parseFloat(saved) : 0);
	}

	$effect(() => {
		const cv = playerStore.currentVideo;
		const p = videoListStore.selectedProvider;
		if (playerStore.view === 'video' && cv) {
			document.title = `${cv.filename} - ${p} - Video Editor`;
		} else {
			document.title = `${p} - Video Editor`;
		}
	});

	async function handleVideoClick(video: (typeof videoListStore.videos)[number]) {
		const idx = filteredVideos.findIndex(v => v.filename === video.filename && v.type === video.type);
		if (idx !== -1) {
			const itemTop = idx * ITEM_HEIGHT - window.scrollY;
			playerStore.captureScrollAnchor(itemTop / window.innerHeight);
		}

		searchHidden = true;
		playerStore.playVideo(video);
	}

	function handleScroll() {
		if (playerStore.view === 'video') return;

		const currentScrollY = window.scrollY;
		scrollY = currentScrollY;

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

	$effect(() => {
		const target = playerStore.scrollTarget;
		if (!target) return;
		const idx = filteredVideos.findIndex(
			(v) => v.filename === target.filename && v.type === target.type
		);
		if (idx === -1) return;
		const targetY = Math.max(0, idx * ITEM_HEIGHT - target.ratio * window.innerHeight);
		window.scrollTo(0, targetY);
		scrollY = targetY;
	});

	$effect(() => {
		if (playerStore.view === 'video') {
			searchHidden = true;
		} else {
			const currentY = window.scrollY;
			scrollY = currentY;
			lastScrollY = currentY;
			searchHidden = currentY > 50;
		}
	});

	function isActiveVideo(video: (typeof videoListStore.videos)[number]): boolean {
		const active = playerStore.currentVideo || playerStore.lastPlayedVideo;
		if (!active) return false;
		return video.filename === active.filename && video.type === active.type;
	}

	function switchProvider(direction: 1 | -1) {
		const currentIdx = (PROVIDERS as readonly string[]).indexOf(videoListStore.selectedProvider);
		const newIdx = currentIdx + direction;
		if (newIdx < 0 || newIdx >= PROVIDERS.length) return;
		const newProvider = PROVIDERS[newIdx];
		localStorage.setItem(STORAGE_KEYS.SELECTED_PROVIDER, newProvider);
		goto(`/videos/${newProvider}`, { replaceState: true });
	}
</script>

<svelte:window onscroll={handleScroll} />

<div class="search-container" class:hidden={searchHidden}>
	<AliasSelector />
</div>

<div class="list-container" use:swipeable={{ providers: PROVIDERS, getProvider: () => videoListStore.selectedProvider, onSwitch: switchProvider, isEnabled: () => playerStore.view === 'list' }}>
	{#if videoListStore.isLoading}
		<p class="info-message">Loading...</p>
	{:else if filteredVideos.length === 0}
		<p class="info-message">No videos found.</p>
	{:else}
		<div class="virtual-spacer" style:height="{totalHeight}px">
			<div style:transform="translateY({offsetY}px)">
				{#each visibleVideos as video (video.filename + video.type)}
					<VideoItem
						{video}
						isActive={isActiveVideo(video)}
						isLastActioned={playerStore.lastActionedVideoFilename === video.filename}
						onclick={() => handleVideoClick(video)}
					/>
				{/each}
			</div>
		</div>
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
		touch-action: pan-y;
	}

	.virtual-spacer {
		position: relative;
	}

	.info-message {
		text-align: center;
		padding: 40px;
		font-style: italic;
		color: #888;
	}
</style>
