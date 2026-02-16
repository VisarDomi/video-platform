# Changelog

## 2026-02-16
- **feature**: Move add-to-list button from tango to TL provider (VERON-65)
  - **rationale**: Tango had 5 buttons (mute, follow, list, ok/cut, pin) which were too small on mobile. Removed list button from tango to restore 4 bigger buttons. Added list button as 4th button in TL controls (mute, follow, block, list). Both TL and tango share the same tango-list API backend.
  - **files**: `PlayerControls.svelte` (removed list logic), `TlControls.svelte` (added list button), `list-api.ts` (added 'tl' to apiMap)

- **fix**: Debounce swipe after pinch-to-zoom (VERON-55)
  - **root cause**: After releasing a pinch-to-zoom or pan gesture, the next single-finger touch immediately entered swipe handling, causing accidental navigation or seek.
  - **decision**: Track `lastZoomEnd` timestamp when pinch/pan ends. In `handleTouchStart`, ignore single-finger touches within 300ms of the last zoom interaction.
  - **files**: `VideoPlayer.svelte` (added `lastZoomEnd` + `ZOOM_DEBOUNCE_MS`, set on pinch/pan end, checked on touch start)

## 2026-02-13
- **fix**: Restore edit controls (pin, cut/save, return to original) for tango/fc2/sc providers
  - **root cause**: `VideoPlayer.svelte` had a 3-way branch: TL -> `TlControls`, follow providers -> `FollowControls`, else -> `PlayerControls`. The follow providers branch only showed mute + follow/unfollow, no edit buttons.
  - **decision**: All non-TL providers use `PlayerControls` as the single control row. Follow/unfollow button is conditionally rendered inside `PlayerControls` when the provider is a follow provider (tango/fc2/sc). One row of icons, all conditionally shown based on video type, live status, and follow state. `FollowControls` component is now unused.
  - **files**: `PlayerControls.svelte` (added follow logic + button), `VideoPlayer.svelte` (simplified to TL vs PlayerControls)
