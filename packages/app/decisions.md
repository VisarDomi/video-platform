# App Decisions

## Pure TypeScript and native Safari navigation (2026-07-29)

The frontend is a pure TypeScript/Vite application. The old Svelte implementation
remains available in Git history and is not part of the build.

Provider lists and viewers are separate native documents. List rows are anchors.
Safari owns tabs, history, scrolling, scroll restoration, edge-back, and viewer
vertical movement. Viewer midpoint selection rotates three media scopes and uses
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
scope, a natural-height current scope, and a 10,000px next scope. At rest the
previous/next videos park at their far edges. On vertical intent they align
beside the current video so the videos touch directly.

Videos use `width:100%; height:auto`; decoded media geometry is the layout
authority. No stage or scope clips video overflow. All three videos play muted.

As in Stream Viewer (ported 2026-09-08), a neighboring video becomes current
when it contains the visual viewport midpoint. Scope roles rotate while a
measured stage translation preserves the selected video's screen position;
there is no scroll-position write during native momentum. Only the remote
edge unit is recycled, and outgoing progress is saved before rotation.

On `scrollend`, with no finger down, normalize the translation immediately:
there is no 100ms timer. Keep the visible current video's position. A landing
in the blank 10k runway selects only the next entry when scrolling down or
previous entry when scrolling up, then centers it. Missing neighbors retain
the current real video. Finger release cannot settle ongoing momentum.

The URL-selected HLS source is assigned before the full provider list or
auxiliary requests. Current playback never waits for neighbor discovery.

One shared overlay remains stationary and latches to the midpoint-selected video;
its controls remain non-interactive until scrolling settles.
It is a transparent fixed shell at the viewport edges. Only its controls paint
pixels and receive pointer events. Do not add a full-shell background, gradient,
backdrop filter, or blur: a painted fixed backdrop makes Safari's browser chrome
opaque.

## preventDefault only for application-owned gestures

Safari owns vertical panning and leading-edge Back. The gesture handler calls
`preventDefault` only for horizontal seek/control gestures or application zoom.
Pinch zoom remains browser-owned.

## localStorage debounce: 3s

Video playback position saves to localStorage every 3s instead of on every timeupdate (12x/sec). Reduces write pressure.

## HLS reconnection: native vs HLS.js

HLS.js: `startLoad()` from current position. Native HLS (iOS Safari): must reload the source entirely — there's no equivalent of startLoad.

## Native live finalization reconciliation

Native Safari can change a playing stream from an infinite live duration to a
finite duration before the server playlist request observes `#EXT-X-ENDLIST`.
When native duration is finite but parsed playlist truth is still live, the
owning player unit refetches playlist authority once per second. It stops as
soon as the playlist becomes VOD or the unit loads different media. This retry
is scoped to an observed authority disagreement; it is not general playlist
polling.

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

## Rules

- Verify frontend changes against the running app, not only static code.
- Preserve native Safari list/viewer navigation, bfcache restoration, and edge-back
  ownership.
- The viewer is a native scrolling 10k/natural/10k three-scope document.
  Videos use intrinsic `width: 100%; height: auto` geometry without clipping.
- Player units own video, timeline, and media lifecycle. One fixed overlay,
  inset from Safari's top and bottom boundaries, latches to the settled scope.

## Scroll regression check

After `npm run build:app`, run `node packages/app/test/viewer.mjs` from the repo
root. It loads the deployed frontend (default `https://192.168.1.197:9999`,
override with `VIDEO_TEST_ORIGIN`) with isolated API/media fixtures. Cases cover
midpoint continuity without scroll writes, immediate settlement, held fingers,
continued momentum, directional spacer landings, reversal and list boundaries,
native URL history, progress persistence, marker reset, mute, and seeking.
Non-GET requests are blocked; no real edits or download-list changes occur.
This is a behavioral regression test, not proof of physical iPhone momentum
or native HLS playback; those still need an on-phone check.
