# Changelog

## 2026-02-22

- **fix**: Black screen on swipe navigation between streams
  - **root cause**: `loadStream` had a skip optimization that checked `el.dataset.loadedFilename === v.filename` to avoid re-loading an already-loaded stream. But HLS instances can be destroyed (by component lifecycle recreating the `hlsInstances` Map, or by TL 404 error handlers) without clearing `dataset.loadedFilename`. Result: `loadStream` thinks the video is loaded but HLS is dead — black screen with no src.
  - **decision**: (1) Changed skip check to triple validation: filename match AND active HLS/native stream (`hlsInstances.has(el)` or `nativeAbortControllers.has(el)`) AND `!!el.src`. If filename matches but stream is dead, clear `dataset.loadedFilename` and re-load. (2) In the TL 404 error handler, `delete el.dataset.loadedFilename` when destroying HLS so the stale marker is cleaned up at the source.
  - **files**: `VideoPlayer.svelte` (`loadStream` stale stream detection, HLS error handler `loadedFilename` cleanup)

- **refactor**: TL provider — unified loading with IDB-first resolution and leftover consumption
  - **root cause**: On first open, streams appeared progressively (liveUrl=null → resolved one-by-one). On second open with IDB cache, Phase 0 ran separately and `setVideos()` bulk-loaded cached liveUrls, breaking the progressive UX.
  - **design**: (1) Removed Phase 0 (`processIdbCache`). IDB is now checked inline per-streamer via `resolveStreamerLiveUrl` helper (IDB-first → masterListUrl fallback). (2) After endpoint list consumed, `consumeLeftoverIdb` processes IDB entries not in endpoint — only adds to list if alive, with same costreamer logic. (3) Expanded IDB schema (v3) to store full streamer fields (`streamId`, `alias`, `firstName`, `isFollowing`, `parentAlias`) so leftover entries can be reconstituted into `TlStreamer` objects. (4) `putCached` now accepts a streamer object instead of individual fields. (5) Same progressive UX on every app open — streams appear with null liveUrl, light up one-by-one.
  - **files**: `tl-cache.ts` (expanded `CachedStreamer` interface, DB v3, `putCached` signature change, `getAllCached` returns full entries), `+page.svelte` (new `resolveStreamerLiveUrl` + `consumeLeftoverIdb`, removed `processIdbCache`, rewrote `processNewStreamer` + co-streamer resolution, updated `putCached` calls in `reprocessExistingStreamer`), `TL_PROVIDER.md` (updated architecture docs)

- **feature**: TL provider — process IDB cache on startup, remove 30s artificial delay
  - **design**: (1) On queue start (app launch or provider return), process all IndexedDB entries first — checkLiveUrl against tango.me, remove 404s. Cleans stale liveUrls from previous sessions where the app was killed by the OS. (2) Removed REFRESH_GATE_MS (30s) wait between queue cycles — the queue paces itself naturally via 200ms per-item delay. (3) Added `getAllCached()` to tl-cache.ts.
  - **files**: `+page.svelte` (new `processIdbCache` phase, removed 30s wait), `tl-cache.ts` (`getAllCached`), `TL_PROVIDER.md` (updated Phase 0 docs)

- **refactor**: TL provider — replace 30s refresh timer with continuous processing queue
  - **root cause**: After PWA returns from background, old streams show black because (1) no visibility change detection, (2) `loadStream` early-returns on same filename (stale HLS persists), (3) passive player 404s silently swallowed. The 30s timer only added new streams but never re-checked existing ones for liveness.
  - **design**: (1) Continuous queue loop replaces 30s `setInterval`: fetch endpoint → process new → reprocess existing → repeat. (2) Reprocessing checks cached liveUrl against tango.me first (source of truth). If dead, tries resolving new liveUrl from masterListUrl + checks that. Only removes when BOTH confirmed 404. (3) VideoPlayer no longer handles TL removal — just destroys HLS on 404. Queue is the single authority. (4) New `$effect` in VideoPlayer watches if current video is removed from list → navigates to next. (5) `onLiveUrlDead` callback removed — no longer needed.
  - **files**: `+page.svelte` (queue: `startTlQueue`, `fetchAndProcessNew`, `reprocessExisting`, `processNewStreamer`, `reprocessExistingStreamer`; removed: `processStreamersEagerly`, `refreshTlStreams`, `handleLiveUrlDead`, timer functions), `VideoPlayer.svelte` (simplified HLS error handler for TL — just destroy; removed `checkLiveUrl` import; added video-removed-from-list effect), `videoList.svelte.ts` (removed `onLiveUrlDead`), `TL_PROVIDER.md` (updated architecture docs)

## 2026-02-21

- **refactor**: TL provider rewrite — liveUrl as source of truth, 30s refresh, organic 404 removal
  - See `TL_PROVIDER.md` for the full architecture document.
  - **design**: (1) liveUrl is source of truth — only a true 404 from tango.me removes a stream. (2) processStreamersEagerly resolves liveUrl from masterListUrl, falls back to IDB cache — no removal during processing. (3) 30s interval replaces scroll-triggered refresh; duplicate check (same s+m) skips, new/changed streams get queued. (4) Video playback: HLS.js 404 → checkLiveUrl against tango.me → if dead, remove from list + memory + IDB. (5) IDB simple: store on resolve, remove on 404 or 24h sweep.
  - **files**: `+page.svelte` (processStreamersEagerly simplified, softRefresh removed, 30s interval, handleLiveUrlDead), `videoList.svelte.ts` (onLiveUrlDead callback, hideStreamers removed), `VideoPlayer.svelte` (TL 404 → checkLiveUrl against tango.me), `tl-proxy.routes.ts` (X-TL-LiveUrl-Dead header on 404), `tl-cache.ts` (simplified header), `TL_PROVIDER.md` (new architecture doc)

- **fix**: TL provider removes 404 streams instead of black screen
  - **root cause**: When a stream died, the masterPlaylistUrl would 404 but the code preserved the stale cached liveUrl (assuming it might still serve). Nobody checked the **liveUrl** itself. The liveUrl is the source of truth — only its 404 confirms a dead stream.
  - **decision**: (1) New backend `POST /tl/check-live-url` does GET against the liveUrl on tango.me. (2) `processStreamersEagerly`: when masterListUrl fails, checks cached liveUrl — if liveUrl also 404s, hides stream. If liveUrl alive, keeps it. (3) `removeCached` gains `force` param to bypass 24h guard for confirmed-dead liveUrls.
  - **files**: `tl-proxy.routes.ts` (new check-live-url endpoint), `constants.ts` (TL_API.CHECK_LIVE_URL), `tl-api.ts` (checkLiveUrl fn), `tl-cache.ts` (removeCached force param), `+page.svelte` (liveUrl 404 checks in eager processing)

- **feature**: TL provider soft refresh + IndexedDB liveUrl cache
  - **rationale**: Every navigation to TL wiped all state and did a full API reload, causing a flash of "Loading..." and losing scroll position, co-streamer positions, and resolved liveUrls. Now saves an in-memory snapshot when leaving TL and restores it instantly on return. Background soft refresh removes dead streams, adds new ones, and uses IndexedDB-cached liveUrls (keyed by streamerId) to avoid re-resolving unchanged streams. Initial load also resolves liveUrls eagerly to warm the cache.
  - **decisions**: (1) In-memory snapshot for instant restore — survives provider switches within session, not page reloads. (2) IndexedDB for liveUrl persistence — keyed by streamerId with masterListUrl for cache invalidation on stream restarts. (3) Co-streamer + liveUrl resolution merged into single sequential `processStreamersEagerly` pass: for each streamer, check co-streamers first, resolve liveUrl for main + any co-streamers, then next. 200ms delay between each resolution. (4) New lightweight `POST /tl/resolve-live-url` backend endpoint reuses existing `resolveLiveUrl()` without creating proxy sessions. (5) Hardcoded TL page constants extracted to `TL_PAGE` config in constants.ts.
  - **files**: `tl-proxy.routes.ts` (new resolve-live-url endpoint), `constants.ts` (TL_API.RESOLVE_LIVE_URL, TL_PAGE config), `tl-api.ts` (liveUrl on TlStreamer, resolveLiveUrl function), `videoList.svelte.ts` (initializeSoft, removeStreamers, updateStreamerLiveUrl), `tl-cache.ts` (new — IndexedDB wrapper + in-memory snapshot), `+page.svelte` (soft refresh orchestration, processStreamersEagerly, snapshot save/restore)

- **fix**: IDB entries only deleted after 24h — guards against aggressive removal of live liveUrl
  - **rationale**: A stream can momentarily disappear from the API response while its liveUrl still serves segments. `removeCached` and `sweepOrphans` now check a `cachedAt` timestamp and only delete entries older than 24h. IDB schema bumped v1→v2 for `cachedAt` field.
  - **files**: `tl-cache.ts` (CachedStreamer.cachedAt, MAX_AGE_MS, DB_VERSION=2, removeCached/sweepOrphans 24h guard)

- **fix**: never overwrite cached liveUrl with null — masterListUrl can 404 while liveUrl still serves segments
  - **root cause**: `processStreamersEagerly` called `putCached(id, url, null)` when `resolveLiveUrl` returned null, overwriting a previously valid liveUrl in IndexedDB. The masterListUrl (master playlist) can go stale/404 while the resolved liveUrl (720p sub-playlist) continues serving segments. liveUrl is the most important cached data.
  - **decision**: (1) `putCached` now guards against null downgrade — if an entry already has a liveUrl, a null write is silently skipped. (2) `processStreamersEagerly` only calls `putCached` on successful resolution. (3) liveUrl entries are only deleted via `removeCached`/`sweepOrphans` (stream gone from API). Documented in `tl-cache.ts` header and `processStreamersEagerly` comment.
  - **files**: `tl-cache.ts` (putCached null guard + doc comment), `+page.svelte` (only putCached on success, doc comment)

- **fix**: refreshTlStreams 404 check targets tango.me instead of local HLS
  - **root cause**: The 404 HEAD check hit `/hls/${alias}/playlist.m3u8` which only exists after the user clicks to play. All unplayed streamers returned 404, causing them to be removed from their position and re-added at the bottom of the list. Following streamers at the top would jump to the end on every scroll-triggered refresh.
  - **decision**: Three-way classification: (1) new alias → append, (2) same alias but different masterListUrl → different stream, remove old + append new at bottom, (3) same alias + same masterListUrl → liveness check via `resolveLiveUrl` (backend → tango.me with auth cookies). Dead on source (null) → remove + re-add. Still alive → update cached liveUrl. All categories feed into `processStreamersEagerly` queue for co-streamer checks + liveUrl resolution. `resolveLiveUrl` never throws (catch returns null), so no dead catch block. Soft refresh uses same masterListUrl comparison + IDB cache.
  - **files**: `+page.svelte` (refreshTlStreams rewritten, softRefreshTlStreams 404 block removed)

- **feature**: Change app icon to capital "V" on purple background
  - **rationale**: Match comix-frontend icon style (capital letter on #5B5FC7 purple rounded rectangle). Replaces old scissors/film-strip icon with consistent branding across apps — "C" for comix, "V" for video.
  - **files**: `static/favicon.ico`, `static/icon-192.png`, `static/icon-512.png`, `static/apple-touch-icon.png`, `static/apple-touch-icon-precomposed.png`, `static/apple-touch-icon-120x120.png`, `static/apple-touch-icon-120x120-precomposed.png`

## 2026-02-19

- **feature**: Enable native Safari zoom in video player
  - **rationale**: After removing custom pinch-to-zoom, there was no zoom at all in video view. Changed `touch-action: none` to `touch-action: pinch-zoom` so Safari handles zoom natively. Added `visualViewport.scale` check to yield to native panning when zoomed — swipe gestures only active at 1x. Also moved `e.preventDefault()` below guards so native pan isn't blocked when zoomed. Added 300ms multi-touch debounce so pinch-out release doesn't trigger accidental swipes (remaining finger after first lifts).
  - **files**: `VideoPlayer.svelte` (changed touch-action CSS, added `isViewportZoomed()` guard, `lastMultiTouchTime` debounce, reordered preventDefault)

- **refactor**: Remove custom pinch-to-zoom from video player
  - **root cause**: Pinch-to-zoom had a critical bug where `wasMultiTouch` got permanently stuck `true` after lifting one finger mid-pinch, blocking all future single-finger gestures until app restart. Additional issues: stale `swipeStartX/Y` caused wrong swipe direction detection, and remaining finger after pinch triggered accidental swipes.
  - **decision**: Removed all zoom code rather than fixing it. The complexity of managing multi-touch lifecycle in a `touch-action: none` PWA on iOS is not worth it. Swipe gestures (seek, nav, edge-back, ui) are the core UX. Touch handlers now guard with `e.touches.length !== 1` so multi-touch is simply ignored.
  - **files**: `VideoPlayer.svelte` (removed ~100 lines: zoom state, pinch functions, pan logic, zoom transform; simplified touch handlers)

- **fix**: TL provider addToList not tracking correctly against tango.txt
  - **root cause**: `loadTlStreams` early-returned before `fetchListIdentifiers('tl')` was ever called, so `listIdentifiers` stayed empty. The API mapping (`tl: TANGO_LIST_API`) was already correct — TL's +/- button adds/removes from tango.txt. The only missing piece was loading the tango list on TL init so the UI could show which streamers are already tracked.
  - **decision**: Added `fetchListIdentifiers('tl')` call inside `loadTlStreams` after videos are set.
  - **files**: `+page.svelte` (call `fetchListIdentifiers` in TL loading path)

## 2026-02-17

- **refactor**: Rename tango API endpoints for consistency (VERON-82)
  - **rationale**: `/api/tango-list/*` renamed to `/api/tango/*` to match fc2/sc pattern. Tango follow API moved from `/api/tango/*` to `/api/tango-follow/*` to avoid conflict.
  - **files**: `constants.ts` (updated `TANGO_LIST_API` and `TANGO_API` paths)

- **feature**: Add video count to filter aliases, sort by count descending
  - **rationale**: When filtering by alias, there was no way to see how many videos each alias has. Adds a count in parentheses next to each alias in the dropdown list and selected chips. Aliases sorted by count (most videos first) instead of alphabetically.
  - **files**: `AliasSelector.svelte` (added `aliasCounts` derived map from `extractAlias`, display count in dropdown items and chips, `.count` style, sort aliases by count descending)

- **fix**: Make text selectable in video view
  - **root cause**: `.video-view` had `user-select: none` and `-webkit-user-select: none`, blocking all text selection (e.g. streamer name). This was an old workaround — the gesture system already handles touches via `preventDefault()`.
  - **decision**: Remove `user-select: none`. Keep `touch-action: none` (needed for swipe/pinch gesture system). No double-tap zoom guard was found.
  - **files**: `VideoPlayer.svelte` (removed 2 lines from `.video-view` styles)

- **fix**: Restore seeking for live videos on non-TL providers
  - **root cause**: Both swipe-seek and progress bar scrubbing were gated on `!isLive`. For non-TL providers (tango/fc2/sc), "live" means a recording in progress — seeking through already-available segments should work. Swipe-seek checked `!playerStore.currentVideo?.isLive`, progress bar derived `effectiveDuration` as 0 when `duration === Infinity`.
  - **decision**: Track `seekableEnd` from `el.seekable` TimeRanges on each `timeupdate`. For non-TL live videos, use `seekableEnd` as the display duration so the progress bar shows a real timeline. Allow swipe-seek when `!isTl` even if `isLive`. TL live streams remain unseekable (truly live content).
  - **files**: `VideoPlayer.svelte` (added `seekableEnd` state, `displayDuration` derived, updated swipe-seek condition and clamp logic, pass `displayDuration` to ProgressBar)

## 2026-02-16

- **refactor**: Rename .txt-based API endpoints for consistency
  - **rationale**: fc2/sc/tango-list all manage .txt files but used follow/unfollow naming. Renamed to list/add/remove to distinguish from real platform follow (tango API). follow-api.ts now only handles tango platform follow; list-api.ts handles all .txt providers.
  - **files**: `constants.ts` (SC_API, FC2_API, TANGO_LIST_API keys), `follow-api.ts` (stripped to tango only), `list-api.ts` (added fc2/sc), `PlayerControls.svelte` (uses both apis), `TlControls.svelte` (list button with +/- icons)

- **fix**: Consistent icons — .txt providers get +/- buttons, platform follow gets hearts
  - **rationale**: All .txt-based providers (tango/fc2/sc/tl list) use +/- with green/red borders. Only TL's real follow uses white/red heart. Previous code mixed icons across provider types.
  - **files**: `PlayerControls.svelte`, `TlControls.svelte`

- **fix**: Missing space between alias and name in TL video player (VERON-57)
  - **root cause**: Svelte whitespace between `{/if}` blocks can collapse. List view already used template literal fix.
  - **decision**: Apply same `` {` ${s.firstName}`} `` pattern to VideoPlayer.svelte top bar.
  - **files**: `VideoPlayer.svelte`

- **feature**: Move add-to-list button from tango to TL provider (VERON-65)
  - **rationale**: Tango had 5 buttons (mute, follow, list, ok/cut, pin) which were too small on mobile. Removed list button from tango to restore 4 bigger buttons. Added list button as 4th button in TL controls (mute, follow, block, list). Both TL and tango share the same tango-list API backend.
  - **files**: `PlayerControls.svelte` (removed list logic), `TlControls.svelte` (added list button), `list-api.ts` (added 'tl' to apiMap)

- **refactor**: Replace inline `style=` with Svelte 5 `style:` directives
  - **rationale**: Svelte 5 best practice — `style:transform={value}` instead of `style="transform: {value}"`. Applies `null` to remove the property rather than empty string.
  - **files**: `VideoPlayer.svelte` (zoom transform, swipe transform), `ProgressBar.svelte` (fill width, marker left), `+page.svelte` (virtual scroll height + offset)

- **fix**: Debounce swipe after pinch-to-zoom (VERON-55)
  - **root cause**: After releasing a pinch-to-zoom or pan gesture, the next single-finger touch immediately entered swipe handling, causing accidental navigation or seek.
  - **decision**: Track `lastZoomEnd` timestamp when pinch/pan ends. In `handleTouchStart`, ignore single-finger touches within 300ms of the last zoom interaction.
  - **files**: `VideoPlayer.svelte` (added `lastZoomEnd` + `ZOOM_DEBOUNCE_MS`, set on pinch/pan end, checked on touch start)

## 2026-02-13
- **fix**: Restore edit controls (pin, cut/save, return to original) for tango/fc2/sc providers
  - **root cause**: `VideoPlayer.svelte` had a 3-way branch: TL -> `TlControls`, follow providers -> `FollowControls`, else -> `PlayerControls`. The follow providers branch only showed mute + follow/unfollow, no edit buttons.
  - **decision**: All non-TL providers use `PlayerControls` as the single control row. Follow/unfollow button is conditionally rendered inside `PlayerControls` when the provider is a follow provider (tango/fc2/sc). One row of icons, all conditionally shown based on video type, live status, and follow state. `FollowControls` component is now unused.
  - **files**: `PlayerControls.svelte` (added follow logic + button), `VideoPlayer.svelte` (simplified to TL vs PlayerControls)
