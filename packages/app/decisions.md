# App Decisions

## iOS PWA: visibilitychange doesn't fire on screen unlock

Safari in PWA standalone mode often skips `visibilitychange` when the phone is unlocked. ConnectionMonitor uses `pageshow` and `focus` as fallbacks. WatchdogService detects event loop freezes (tab backgrounded, phone locked) by measuring interval drift — if actual tick exceeds expected by > 2.5s, the app was frozen.

## iOS PWA: auto-zoom on rotation

iOS standalone PWA auto-zooms on rotation. Three mitigations: force viewport recalculation on resize, prevent Safari pinch-zoom gestures via touch-action CSS, and fix the standalone viewport meta.

## Swipe gesture constants

`SWIPE_THRESHOLD = 0.15` (15% of screen width to commit), `DEADZONE_RATIO = 0.013`, `EDGE_ZONE_RATIO = 0.077`. `NAV_COMMIT_THRESHOLD = 0.2` (20% of viewport height for vertical nav peek).

## preventDefault AFTER axis lock

Swipe gesture handler calls `preventDefault` only after axis lock is determined, not before. Otherwise it blocks vertical scroll before we know the gesture is horizontal.

## Zoom reset on nav

When starting a navigation gesture, zoom is reset to 1x because nav transforms (translateX) conflict with zoom transforms (scale + translate). Can't compose both.

## localStorage debounce: 3s

Video playback position saves to localStorage every 3s instead of on every timeupdate (12x/sec). Reduces write pressure.

## HLS reconnection: native vs HLS.js

HLS.js: `startLoad()` from current position. Native HLS (iOS Safari): must reload the source entirely — there's no equivalent of startLoad.

## videoList epoch counter

`initialize()` bumps an epoch counter. Async operations capture the epoch and bail if it changed (means another initialize() ran). Prevents stale async results from writing provider-scoped state.

## videoList: sole writer pattern

`initialize()` is the sole writer for all provider-scoped state. Atomic transition — all state is set in one synchronous block after async data arrives, gated by epoch check.
