# App Decisions

## Pure TypeScript and native Safari navigation (2026-07-29)

The frontend is a pure TypeScript/Vite application. The old Svelte implementation
is retained under `src_old` as reference and is not part of the build.

Provider lists and viewers are separate native documents. List rows are anchors.
Safari owns tabs, history, scrolling, scroll restoration, and edge-back. Vertical
video navigation rotates three complete player units and uses
`history.replaceState()`, so Back always returns to the list entry.

The list renders every row without virtualization or filtering. On `pagehide` it
stops and aborts polling. On bfcache `pageshow` it immediately refetches the full
list, reconciles the restored DOM without scrolling, then starts exactly one
poller. Polling only discovers new videos while the list remains open.

PWA support, watchdog/sentinel timers, and the frontend `/api/log` pipeline were
removed. Viewer recovery responds directly to browser lifecycle and connectivity
events.

## Viewer gesture constants

`DEADZONE_RATIO = 0.013`. `NAV_COMMIT_THRESHOLD = 0.2` (20% of viewport height
for vertical video navigation). The leading `28px` edge is left to Safari.

## preventDefault AFTER axis lock

Swipe gesture handler calls `preventDefault` only after axis lock is determined, not before. Otherwise it blocks vertical scroll before we know the gesture is horizontal.

## Zoom reset on video navigation

When starting a navigation gesture, zoom is reset to 1x because unit translation
conflicts with zoom transforms.

## localStorage debounce: 3s

Video playback position saves to localStorage every 3s instead of on every timeupdate (12x/sec). Reduces write pressure.

## HLS reconnection: native vs HLS.js

HLS.js: `startLoad()` from current position. Native HLS (iOS Safari): must reload the source entirely — there's no equivalent of startLoad.

## List request generations

List refreshes use an `AbortController` and request generation so stale
responses cannot overwrite a newer reconciliation.

## List reconciliation is the sole DOM writer

Initial load, polling, and bfcache refresh all pass through one reconciliation
function. On `pagehide`, polling stops and the in-flight request is aborted. On
bfcache `pageshow`, a full refresh completes before exactly one poller resumes.

## No frontend playlist cache

`fetchAndParsePlaylist` reads from the server on every call. No Map cache.

**Why:** A cache can freeze `isLive` state and make a live stream appear as VOD.

## No frontend passthrough logging

The frontend does not post diagnostic events to the server. The old
`POST /api/log` route, logging helpers, watchdog, and timer-drift sentinel are
removed.
