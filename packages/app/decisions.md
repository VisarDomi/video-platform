# App Decisions

## Pure TypeScript and native Safari navigation (2026-07-29)

The frontend is a pure TypeScript/Vite application. The old Svelte implementation
remains available in Git history and is not part of the build.

Provider lists and viewers are separate native documents. List rows are anchors.
Safari owns tabs, history, scrolling, scroll restoration, edge-back, and viewer
vertical movement. Viewer settlement rotates three media scopes and uses
`history.replaceState()`, so Back always returns to the list entry.

The list renders every row without virtualization or filtering. On `pagehide` it
stops and aborts polling. On bfcache `pageshow` it immediately refetches the full
list, reconciles the restored DOM without scrolling, then starts exactly one
poller. Polling only discovers new videos while the list remains open.

PWA support, watchdog/sentinel timers, and the frontend `/api/log` pipeline were
removed. Viewer recovery responds directly to browser lifecycle and connectivity
events.

## Intrinsic three-scope viewer (2026-07-29)

The viewer document always contains three media scopes: a 10,000px previous
scope whose video is bottom-aligned, a natural-height current scope, and a
10,000px next scope whose video is top-aligned. The videos touch directly.

Videos use `width:100%; height:auto`; decoded media geometry is the layout
authority. No stage or scope clips video overflow. All three videos play muted.

After `scrollend + 100ms`, a neighboring video becomes current only when it has
a strictly greater visible fraction than both others. Ties retain current.
Scope roles rotate with measured scroll correction, and only the remote edge
unit is recycled.

The URL-selected HLS source is assigned before the full provider list or
auxiliary requests. Current playback never waits for neighbor discovery.

One shared overlay remains stationary and latches to the settled current video.
It is a transparent fixed shell at the viewport edges. Only its controls paint
pixels and receive pointer events. Do not add a full-shell background, gradient,
backdrop filter, or blur: a painted fixed backdrop makes Safari's browser chrome
opaque.

## preventDefault only for application-owned gestures

Safari owns vertical panning and leading-edge Back. The gesture handler calls
`preventDefault` only for horizontal seek/control gestures or application zoom.
Starting vertical movement resets zoom.

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
