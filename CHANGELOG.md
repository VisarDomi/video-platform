# Changelog

## 2026-02-19

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
