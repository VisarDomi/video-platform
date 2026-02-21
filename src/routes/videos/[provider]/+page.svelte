<script lang="ts">
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { PROVIDERS, DEFAULT_PROVIDER, STORAGE_KEYS, TL_PAGE } from '$lib/constants.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { playerStore } from '$lib/stores/player.svelte.js';
	import { fetchVideos } from '$lib/services/api.js';
	import { startSync, stopSync } from '$lib/services/sync.js';
	import { filterByAliases } from '$lib/utils/filter.js';
	import AliasSelector from '$lib/components/AliasSelector.svelte';
	import VideoItem from '$lib/components/VideoItem.svelte';
	import VideoPlayer from '$lib/components/VideoPlayer.svelte';
	import { fetchAndParsePlaylist } from '$lib/services/hls.js';
	import { fetchFollowing, isFollowProvider } from '$lib/services/follow-api.js';
	import { fetchListIdentifiers, isListProvider } from '$lib/services/list-api.js';
	import {
		fetchStreams,
		resolveLiveUrl,
		startDownload,
		startProxy,
		fetchMultiBroadcast,
		fetchLiveFilenames,
		sendActiveSet,
		syncProxySessions,
		type TlStreamer
	} from '$lib/services/tl-api.js';
	import {
		getCached,
		putCached,
		removeCached,
		sweepOrphans,
		saveTlSnapshot,
		restoreTlSnapshot
	} from '$lib/services/tl-cache.js';
	import { VIDEO_TYPE, API } from '$lib/constants.js';

	const { ITEM_HEIGHT, SCROLL_BUFFER, MIN_LIST_ITEMS, REFRESH_GATE_MS, LIVE_URL_RESOLVE_DELAY_MS } = TL_PAGE;

	let isRefreshing = false;
	let tlRefreshInterval: ReturnType<typeof setInterval> | null = null;
	let lastScrollY = 0;
	let searchHidden = $state(false);
	let scrollY = $state(0);

	const provider = $derived(page.params.provider);

	const filteredVideos = $derived(
		filterByAliases(videoListStore.videos, videoListStore.selectedAliases)
	);

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

		// Save TL snapshot before leaving, stop 30s refresh, clear callback
		if (previousProvider === 'tl' && p !== 'tl') {
			saveTlSnapshot(videoListStore);
			stopTlRefreshInterval();
			videoListStore.onLiveUrlDead = null;
		}

		stopSync();
		sendActiveSet([]);
		syncProxySessions([]);

		// Soft restore for TL if snapshot exists
		if (p === 'tl' && previousProvider !== null && previousProvider !== 'tl') {
			videoListStore.initializeSoft('tl');
			videoListStore.clearAliases();
			playerStore.initialize(p);
			videoListStore.onLiveUrlDead = handleLiveUrlDead;
			const restored = restoreTlSnapshot(videoListStore);
			if (restored) {
				console.log('[TL] restored snapshot, starting 30s refresh');
				startTlRefreshInterval();
			} else {
				videoListStore.initialize(p);
				loadVideos(p);
			}
		} else {
			videoListStore.initialize(p);
			videoListStore.clearAliases();
			playerStore.initialize(p);
			if (p === 'tl') videoListStore.onLiveUrlDead = handleLiveUrlDead;
			loadVideos(p);
		}

		previousProvider = p;
	});

	async function loadVideos(p: string) {
		const epoch = videoListStore.epoch;
		if (p === 'tl') {
			await loadTlStreams(epoch);
			return;
		}
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

	async function loadTlStreams(epoch: number) {
		try {
			const { following, recommended } = await fetchStreams();
			if (videoListStore.epoch !== epoch) return;
			const allStreamers = [...following, ...recommended];
			console.log(
				'[TL] loaded',
				following.length,
				'following +',
				recommended.length,
				'recommended =',
				allStreamers.length,
				'total'
			);
			const map = new Map<string, TlStreamer>();
			const videos = allStreamers.map((s) => {
				map.set(s.alias, s);
				return {
					filename: s.alias,
					type: VIDEO_TYPE.ORIGINAL,
					duration: 0,
					size: 0,
					isLive: true
				};
			});
			videoListStore.setStreamerMap(map);
			videoListStore.setVideos(videos);
			fetchListIdentifiers('tl').then((ids) => {
				if (videoListStore.epoch !== epoch) return;
				videoListStore.setListIdentifiers(ids);
			});
			fetchLiveFilenames().then((filenames) => {
				if (videoListStore.epoch !== epoch) return;
				videoListStore.setLiveFilenames(filenames);
				console.log('[TL] live filenames:', Object.keys(filenames).join(', ') || '(none)');
			});
			void processStreamersEagerly(epoch, allStreamers);
			startTlRefreshInterval();
		} catch (e) {
			console.error('[TL] Failed to load tl streams', e);
			if (videoListStore.epoch !== epoch) return;
			videoListStore.setVideos([]);
		}
	}

	// Resolve liveUrl for each streamer, then check co-streamers.
	// On masterListUrl failure, fall back to IDB cached liveUrl.
	// No removal here — only a 404 on the liveUrl during video playback removes.
	async function processStreamersEagerly(epoch: number, streamers: TlStreamer[]) {
		console.log('[TL:eager] processing', streamers.length, 'streamers');
		let coFound = 0;
		let resolved = 0;

		for (const streamer of streamers) {
			if (videoListStore.epoch !== epoch) break;

			// 1. Resolve liveUrl from masterListUrl
			const liveUrl = await resolveLiveUrl(streamer.masterListUrl);
			if (videoListStore.epoch !== epoch) break;
			if (liveUrl) {
				resolved++;
				videoListStore.updateStreamerLiveUrl(streamer.alias, liveUrl);
				await putCached(streamer.streamerId, streamer.masterListUrl, liveUrl);
			} else {
				// masterListUrl failed — fall back to IDB cached liveUrl
				const cached = await getCached(streamer.streamerId);
				if (cached?.liveUrl) {
					videoListStore.updateStreamerLiveUrl(streamer.alias, cached.liveUrl);
				}
				// no cached liveUrl = stream stays in list without liveUrl (unplayable
				// until next 30s refresh resolves it)
			}

			// 2. Co-streamer check
			if (streamer.streamId && videoListStore.markStreamIdProcessed(streamer.streamId)) {
				try {
					const coStreamers = await fetchMultiBroadcast(streamer.streamId);
					if (videoListStore.epoch !== epoch) break;
					if (coStreamers.length > 0) {
						coFound += coStreamers.length;
						console.log(
							'[TL:eager]',
							streamer.alias,
							'->',
							coStreamers.length,
							'co-streamers:',
							coStreamers.map((s) => s.alias).join(', ')
						);
						const withParent = coStreamers.map((s) => ({
							...s,
							parentAlias: streamer.alias
						}));
						const newVideos = withParent.map((s) => ({
							filename: s.alias,
							type: VIDEO_TYPE.ORIGINAL,
							duration: 0,
							size: 0,
							isLive: true
						}));
						videoListStore.insertVideosAfter(streamer.alias, newVideos, withParent);

						// Resolve liveUrl for each co-streamer
						for (const co of withParent) {
							if (videoListStore.epoch !== epoch) break;
							const coLiveUrl = await resolveLiveUrl(co.masterListUrl);
							if (videoListStore.epoch !== epoch) break;
							if (coLiveUrl) {
								resolved++;
								videoListStore.updateStreamerLiveUrl(co.alias, coLiveUrl);
								await putCached(co.streamerId, co.masterListUrl, coLiveUrl);
							} else {
								const cached = await getCached(co.streamerId);
								if (cached?.liveUrl) {
									videoListStore.updateStreamerLiveUrl(co.alias, cached.liveUrl);
								}
							}
							await new Promise((r) => setTimeout(r, LIVE_URL_RESOLVE_DELAY_MS));
						}
					}
				} catch (e) {
					console.warn('[TL:eager] co-streamer fetch failed for', streamer.alias, e);
				}
			}

			await new Promise((r) => setTimeout(r, LIVE_URL_RESOLVE_DELAY_MS));
		}

		console.log('[TL:eager] done.', coFound, 'co-streamers,', resolved, 'liveUrls resolved');
	}

	// --- 30s refresh interval ---
	// Duplicate = same streamerId + same masterListUrl → skip (stays in position).
	// New = different streamerId, or same streamerId + different masterListUrl → process.

	function startTlRefreshInterval() {
		stopTlRefreshInterval();
		tlRefreshInterval = setInterval(() => void refreshTlStreams(), REFRESH_GATE_MS);
	}

	function stopTlRefreshInterval() {
		if (tlRefreshInterval) {
			clearInterval(tlRefreshInterval);
			tlRefreshInterval = null;
		}
	}

	async function refreshTlStreams() {
		if (isRefreshing) return;
		isRefreshing = true;
		const epoch = videoListStore.epoch;
		console.log('[TL:30s] refreshing...');

		try {
			const { following, recommended } = await fetchStreams();
			if (videoListStore.epoch !== epoch) return;
			const freshStreamers = [...following, ...recommended];

			const toAppend: TlStreamer[] = [];
			const toProcess: TlStreamer[] = [];

			for (const streamer of freshStreamers) {
				if (videoListStore.epoch !== epoch) return;
				const existing = videoListStore.getStreamer(streamer.alias);

				if (!existing) {
					// Different streamerId — new stream
					toAppend.push(streamer);
					toProcess.push(streamer);
					continue;
				}

				if (existing.streamerId === streamer.streamerId && existing.masterListUrl === streamer.masterListUrl) {
					// Duplicate: same s + same m → skip
					continue;
				}

				// Same s + different m = restarted stream → process as new
				console.log('[TL:30s] restarted stream:', streamer.alias);
				videoListStore.removeStreamers([streamer.alias]);
				toAppend.push(streamer);
				toProcess.push(streamer);
			}

			if (toAppend.length > 0) {
				console.log('[TL:30s] appending', toAppend.length, ':', toAppend.map((s) => s.alias).join(', '));
				const nextMap = new Map(videoListStore.streamerMap);
				const newVideos = toAppend.map((s) => {
					nextMap.set(s.alias, s);
					return {
						filename: s.alias,
						type: VIDEO_TYPE.ORIGINAL,
						duration: 0,
						size: 0,
						isLive: true
					};
				});
				videoListStore.setStreamerMap(nextMap);
				videoListStore.appendVideos(newVideos);
			}

			if (toProcess.length > 0) {
				void processStreamersEagerly(epoch, toProcess);
			}

			// Sweep IDB entries older than 24h
			const activeIds = new Set(
				[...videoListStore.streamerMap.values()].map((s) => s.streamerId)
			);
			void sweepOrphans(activeIds);

			// Fire-and-forget: refresh liveFilenames + listIdentifiers
			fetchLiveFilenames().then((filenames) => {
				if (videoListStore.epoch !== epoch) return;
				videoListStore.setLiveFilenames(filenames);
			});
			fetchListIdentifiers('tl').then((ids) => {
				if (videoListStore.epoch !== epoch) return;
				videoListStore.setListIdentifiers(ids);
			});
		} catch (e) {
			console.error('[TL:30s] refresh failed', e);
		} finally {
			isRefreshing = false;
		}
	}

	// --- liveUrl 404 on tango.me → remove stream ---
	// Called by VideoPlayer when the proxy signals X-TL-LiveUrl-Dead: true
	function handleLiveUrlDead(alias: string) {
		const streamer = videoListStore.getStreamer(alias);
		console.log('[TL] liveUrl dead on tango.me, removing:', alias);
		videoListStore.removeStreamers([alias]);
		if (streamer) void removeCached(streamer.streamerId, true);
	}

	function scrollToActiveVideo() {
		const active = playerStore.currentVideo || playerStore.lastPlayedVideo;
		if (!active) return;
		const idx = filteredVideos.findIndex(
			(v) => v.filename === active.filename && v.type === active.type
		);
		if (idx === -1) return;
		const targetY = idx * ITEM_HEIGHT - window.innerHeight / 2 + ITEM_HEIGHT / 2;
		window.scrollTo(0, Math.max(0, targetY));
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
		const saved = localStorage.getItem(`${STORAGE_KEYS.PROGRESS_PREFIX}${video.filename}`);
		const startTime = saved && parseFloat(saved) > 0 ? Math.round(parseFloat(saved)) : 0;

		if (videoListStore.selectedProvider === 'tl') {
			const streamer = videoListStore.getStreamer(video.filename);
			if (streamer) {
				await startProxy(streamer);
				if (streamer.isFollowing && videoListStore.getLiveFilename(video.filename)) {
					console.log('[TL:dl] skipping download for followed stream:', video.filename);
				} else {
					void startDownload(streamer);
				}
			}
		}

		playerStore.playVideo(video, startTime, videoListStore.selectedProvider);
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

<div class="list-container">
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
						streamerInfo={videoListStore.selectedProvider === 'tl'
							? (() => {
									const s = videoListStore.getStreamer(video.filename);
									return s
										? {
												firstName: s.firstName,
												isFollowing: s.isFollowing,
												parentAlias: s.parentAlias
											}
										: undefined;
								})()
							: undefined}
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
