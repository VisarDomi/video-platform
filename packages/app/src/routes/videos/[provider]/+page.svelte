<script lang="ts">
	import { tick, onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { PROVIDERS, DEFAULT_PROVIDER, STORAGE_KEYS, SWIPE_THRESHOLD, DEADZONE_RATIO } from '$lib/constants.js';
	import { appDimensions } from '$lib/state/appDimensions';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { fetchVideos } from '$lib/services/api.js';
	import { startSync, stopSync } from '$lib/services/sync.js';
	import AliasSelector from '$lib/components/AliasSelector.svelte';
	import VideoItem from '$lib/components/VideoItem.svelte';
	import VideoPlayer from '$lib/components/VideoPlayer.svelte';
	import { fetchAndParsePlaylist } from '$lib/services/hls.js';
	import { fetchFollowing, isFollowProvider } from '$lib/services/follow-api.js';
	import { fetchListIdentifiers, isListProvider } from '$lib/services/list-api.js';
	import { VIDEO_TYPE, API } from '$lib/constants.js';

	const ITEM_HEIGHT = 52;
	const SCROLL_BUFFER = 10;
	const MIN_LIST_ITEMS = 100;

	let lastScrollY = 0;
	let searchHidden = $state(false);
	let scrollY = $state(0);

	const provider = $derived(page.params.provider);

	const filteredVideos = $derived(videoListStore.filteredVideos);

	const totalHeight = $derived(Math.max(MIN_LIST_ITEMS, filteredVideos.length) * ITEM_HEIGHT);
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

	// Validate provider and load videos when it changes
	$effect(() => {
		const p = provider ?? DEFAULT_PROVIDER;
		if (!(PROVIDERS as readonly string[]).includes(p)) {
			goto(`/videos/${DEFAULT_PROVIDER}`, { replaceState: true });
			return;
		}

		stopSync();
		playerStore.triggerProviderChange();

		videoListStore.initialize(p);
		videoListStore.clearAliases();
		playerStore.initialize(p);
		loadVideos(p);

		previousProvider = p;
	});

	async function loadVideos(p: string) {
		const epoch = videoListStore.epoch;
		const videos = await fetchVideos(p);
		if (videoListStore.epoch !== epoch) return;
		videoListStore.setVideos(videos);
		if (isFollowProvider(p)) {
			fetchFollowing(p).then((ids) => {
				if (videoListStore.epoch !== epoch) return;
				videoListStore.setFollowedIdentifiers(ids);
			});
		}
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

	async function handleVideoClick(video: (typeof videoListStore.videos)[number]) {
		const idx = filteredVideos.findIndex(v => v.filename === video.filename && v.type === video.type);
		if (idx !== -1) {
			const itemTop = idx * ITEM_HEIGHT - window.scrollY;
			playerStore.captureScrollAnchor(itemTop / window.innerHeight);
		}

		searchHidden = true;
		playerStore.playVideo(video, videoListStore.selectedProvider);
		void fetchAndParsePlaylist(video);
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

	// Scroll document while video overlay covers it
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

	// Hide search when entering video view, reset when returning to list
	$effect(() => {
		if (playerStore.view === 'video') {
			searchHidden = true;
		} else {
			scrollY = window.scrollY;
			lastScrollY = scrollY;
			searchHidden = scrollY > 50;
		}
	});

	function isActiveVideo(video: (typeof videoListStore.videos)[number]): boolean {
		const active = playerStore.currentVideo || playerStore.lastPlayedVideo;
		if (!active) return false;
		return video.filename === active.filename && video.type === active.type;
	}

	// Swipe to switch provider — horizontal gesture state machine
	let listContainerEl: HTMLElement;
	let swipeStartX = 0;
	let swipeStartY = 0;
	let swipeAxis: 'none' | 'horizontal' | 'vertical' = 'none';
	let isSwiping = false;
	let swipeAnimating = false;

	function getAdjacentProvider(dir: 1 | -1): string | null {
		const idx = (PROVIDERS as readonly string[]).indexOf(videoListStore.selectedProvider);
		const newIdx = idx + dir;
		if (newIdx < 0 || newIdx >= PROVIDERS.length) return null;
		return PROVIDERS[newIdx];
	}

	function handleTouchStart(e: TouchEvent) {
		if (playerStore.view !== 'list' || swipeAnimating) return;
		swipeStartX = e.touches[0].clientX;
		swipeStartY = e.touches[0].clientY;
		swipeAxis = 'none';
		isSwiping = false;
	}

	function handleTouchMove(e: TouchEvent) {
		if (playerStore.view !== 'list' || swipeAnimating) return;
		if (swipeAxis === 'vertical') return;

		const touch = e.touches[0];
		const dx = touch.clientX - swipeStartX;
		const dy = touch.clientY - swipeStartY;

		if (swipeAxis === 'none') {
			const deadzone = appDimensions.width * DEADZONE_RATIO;
			if (Math.abs(dx) < deadzone && Math.abs(dy) < deadzone) return;
			if (Math.abs(dy) > Math.abs(dx)) {
				swipeAxis = 'vertical';
				return;
			}
			swipeAxis = 'horizontal';
			isSwiping = true;
		}

		e.preventDefault();

		const dir: 1 | -1 = dx < 0 ? 1 : -1;
		const adjacent = getAdjacentProvider(dir);
		listContainerEl.style.transition = 'none';
		listContainerEl.style.transform = adjacent
			? `translateX(${dx}px)`
			: `translateX(${dx * 0.3}px)`;
	}

	function handleTouchEnd(e: TouchEvent) {
		if (swipeAxis !== 'horizontal' || !isSwiping) {
			swipeAxis = 'none';
			isSwiping = false;
			return;
		}

		const dx = e.changedTouches[0].clientX - swipeStartX;
		const dir: 1 | -1 = dx < 0 ? 1 : -1;
		const adjacent = getAdjacentProvider(dir);

		if (Math.abs(dx) > appDimensions.width * SWIPE_THRESHOLD && adjacent) {
			animateProviderSwitch(dir);
		} else {
			// Snap back
			listContainerEl.style.transition = 'transform 250ms ease-out';
			listContainerEl.style.transform = 'translateX(0)';
			setTimeout(() => {
				listContainerEl.style.transition = '';
				listContainerEl.style.transform = '';
				isSwiping = false;
				swipeAxis = 'none';
			}, 250);
		}
	}

	function handleTouchCancel() {
		listContainerEl.style.transition = '';
		listContainerEl.style.transform = '';
		swipeAxis = 'none';
		isSwiping = false;
	}

	function animateProviderSwitch(direction: 1 | -1) {
		swipeAnimating = true;
		const vw = window.innerWidth;
		const slideOutTarget = direction > 0 ? -vw : vw;

		// Phase 1: Slide current content off-screen
		listContainerEl.style.transition = 'transform 250ms ease-out';
		listContainerEl.style.transform = `translateX(${slideOutTarget}px)`;

		setTimeout(() => {
			// Phase 2: Jump to opposite edge, switch provider
			listContainerEl.style.transition = 'none';
			listContainerEl.style.transform = `translateX(${-slideOutTarget}px)`;
			switchProvider(direction);

			// Phase 3: Slide in from opposite edge
			requestAnimationFrame(() => {
				listContainerEl.style.transition = 'transform 250ms ease-out';
				listContainerEl.style.transform = 'translateX(0)';
				setTimeout(() => {
					listContainerEl.style.transition = '';
					listContainerEl.style.transform = '';
					isSwiping = false;
					swipeAnimating = false;
					swipeAxis = 'none';
				}, 250);
			});
		}, 250);
	}

	onMount(() => {
		const el = listContainerEl;
		el.addEventListener('touchstart', handleTouchStart);
		el.addEventListener('touchmove', handleTouchMove, { passive: false });
		el.addEventListener('touchend', handleTouchEnd);
		el.addEventListener('touchcancel', handleTouchCancel);
		return () => {
			el.removeEventListener('touchstart', handleTouchStart);
			el.removeEventListener('touchmove', handleTouchMove);
			el.removeEventListener('touchend', handleTouchEnd);
			el.removeEventListener('touchcancel', handleTouchCancel);
		};
	});

	function switchProvider(direction: 1 | -1) {
		const currentIdx = (PROVIDERS as readonly string[]).indexOf(videoListStore.selectedProvider);
		const newIdx = currentIdx + direction;
		if (newIdx < 0 || newIdx >= PROVIDERS.length) return;
		const newProvider = PROVIDERS[newIdx];
		videoListStore.setProvider(newProvider);
		goto(`/videos/${newProvider}`, { replaceState: true });
	}
</script>

<svelte:window onscroll={handleScroll} />

<div class="search-container" class:hidden={searchHidden}>
	<AliasSelector />
</div>

<div class="list-container" bind:this={listContainerEl}>
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
