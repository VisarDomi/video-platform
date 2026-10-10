# App Decisions

## Pure TypeScript and native Safari navigation

The frontend is a TypeScript/Vite application without a UI framework; its only runtime
dependency is hls.js.

Provider lists and viewers are separate native documents, and list rows are anchors, so
Safari owns tabs, history, scrolling, edge-back and the viewer's vertical movement. The
viewer changes videos with `history.replaceState()`: opening a video adds one history entry
and Back always returns to the list.

The list renders every row, without virtualization or filtering. A newly loaded list
scrolls to the highlighted (last viewed) row; an online list reopened from history returns
to its saved position (`videoListY` in `history.state`). The viewer sets
`history.scrollRestoration = 'manual'` and positions its videos itself.

## List lifecycle and reconciliation

One reconciliation function writes the list rows for the initial load, polling, restores
and online pages, reusing existing rows by filename and type.

Local lists poll every second for videos after the last filename, only while visible;
polling only adds videos. On `pagehide` or when the page is hidden, polling stops and
in-flight requests are aborted. On bfcache `pageshow`, when the page becomes visible again,
or on `online`, the list refetches the full list, reconciles it into the existing DOM
without scrolling, then starts exactly one poller. Refreshes use an `AbortController` and a
request token, so a stale response cannot overwrite a newer reconciliation.

Online lists page through `services/catalog.ts` instead (see `PROVIDERS.md`).

## No service worker or client logging

The frontend registers no service worker and has no web manifest. It posts no diagnostic
events to the server; errors go to the console. Viewer recovery is driven by `pageshow`,
`visibilitychange` and `online` events, not by watchdog timers.

## Intrinsic three-scope viewer

The viewer document always holds three player units: a 10,000px previous scope, a
natural-height current scope and a 10,000px next scope. At rest the previous and next videos
sit at their scopes' far edges; during vertical navigation (`viewer-navigating`) they align
beside the current video so the videos touch.

Videos use `width: 100%; height: auto`: decoded media geometry is the layout authority, and
no stage or scope clips video overflow. The stage stays hidden until the current video has
dimensions (at most 8 s), then centers it.

All three units play muted; the mute button unmutes only the current video, and a unit is
muted again when it leaves the current scope.

A neighbor becomes current when it contains the visual viewport midpoint. Scope roles rotate
while a stage `translateY` preserves the selected video's screen position, so nothing writes
the scroll position during native momentum. Only the unit at the far edge is recycled, and
the outgoing video's progress is saved before rotation.

Settlement happens on `scrollend` with no finger down, immediately and without a timer;
releasing a finger cannot settle ongoing momentum. It removes the translation and keeps the
current video's visible position. A landing in the blank 10k runway selects only the next
entry when scrolling down or the previous entry when scrolling up, then centers it; at
either end of the list the current video stays.

The viewer starts loading the URL-selected video before anything else and never waits for
the provider list, neighbors or co-streamer discovery to play it.

## Transparent fixed overlay

One fixed overlay stays still and follows the midpoint-selected video; its controls are
disabled until scrolling settles. It is a transparent shell over the whole viewport, padded
inside the top and side safe areas; only its controls paint pixels and receive pointer events. Do not add
a full-shell background, gradient, backdrop filter or blur: a painted fixed backdrop makes
Safari's browser chrome opaque.

## preventDefault only for application-owned gestures

Safari owns vertical panning, pinch zoom and leading-edge Back: touches that start within
28px of the left edge or use more than one finger are left alone, and the stage allows
`touch-action: pan-y pinch-zoom`. The gesture handler calls `preventDefault` only for
horizontal seek drags that start in the upper half of the screen. A horizontal swipe of more
than 80px in the lower half shows (rightward) or hides (leftward) the controls.

## Playback progress

The current video's position is saved to `localStorage` (`video-progress-<filename>`) at most
every 3 s during playback, and on scope rotation, `pagehide` and when the page is hidden.
This keeps write pressure low. Live streams save no progress.

## Player recovery

On bfcache `pageshow`, when the page becomes visible, or on `online`, every player unit
resumes. HLS.js calls `startLoad()` and plays on. Native HLS (iOS Safari) has no equivalent,
so the unit reloads the element and restores the position for VOD. Online videos resolve
their source again only when the element has an error or no source; otherwise they just
play.

## Native live finalization reconciliation

Native Safari can change a playing stream from an infinite live duration to a finite
duration before the server playlist request observes `#EXT-X-ENDLIST`. When a local video's
native duration is finite but the parsed playlist is still live, the owning player unit
refetches the playlist once per second. It stops as soon as the playlist becomes VOD or the
unit loads different media. This retry is scoped to an observed authority disagreement; it
is not general playlist polling.

## No frontend playlist cache

`fetchPlaylist` (`services/hls.ts`) requests the playlist from the server on every call and
keeps no in-memory cache.

**Why:** A cache can freeze `isLive` state and make a live stream appear as VOD.

## The iPhone apps play videos natively

In the iPhone apps a list row opens the app's native viewer instead of the viewer document
(`routes/nativeViewer.ts`; `apps/ios` `VideoApp/ViewerBridge.swift`). The list page posts its
list whenever it changes and answers the viewer's requests (`window.__videoApp.call`):
playback sources, co-streamers, follow, block, list removals and additions, the highlighted
row and the login page. Each video it posts says whether it is a PC recording or a live
stream, its playback source when one is known without a request (`mediaHint`: local HLS,
Tango's remembered playlists) and its download-list streamer. A viewer address opened in the
app opens the list with that video in the native viewer.

**Why:** WebKit pauses a page's video when the phone locks or the app leaves the screen; the
native player plays on until the video ends. Safari has no `videoViewer` handler and keeps the
web viewer below.

## Video Vault lives on porntrex.com

Video Vault lists both upload sites from a page on porntrex.com and reads XVideos pages
through the app's hidden xvideos.com web view.

**Why:** XVideos sends a Content-Security-Policy whose `default-src` lists only its own and
ad hosts, so a page on xvideos.com cannot load Porntrex media. Porntrex sends no policy, and
XVideos' CDN serves its playlists to other origins, so XVideos HLS plays on porntrex.com.
Neither site's pages can be read from the other origin (no CORS), and a hidden iframe would
get no cookies (third-party), hence the app's first-party web view. The vault's URLs are
Porntrex 404 pages, which load whether or not either site is signed in.

## Video Vault lists only the pipeline's uploads

An upload is listed only when its title carries the recording in brackets,
`[YYYY-MM-DD HHMMSS streamer]` (`isPipelineUpload` in `providers/uploadSite.ts`). Older manual
uploads and uploads renamed to the bare `YYYY-MM-DD HHMMSS streamer` stay on the sites but are
not listed.

**Why:** The vault shows the pipeline's archive; an upload renamed to the bare stamp has been
taken out of it.

## Rules

- Verify frontend changes against the running app, not only static code.
- Preserve native Safari list/viewer navigation, bfcache restoration, and edge-back
  ownership.
- The viewer is a native scrolling 10k/natural/10k three-scope document.
  Videos use intrinsic `width: 100%; height: auto` geometry without clipping.
- Player units own video, timeline, and media lifecycle. One transparent fixed overlay
  follows the midpoint-selected video.

## Regression checks

`npm run test:app:webkit` drives the built website and both content scripts in WebKit with
isolated fixtures, including scroll settlement on a local list (see `PROVIDERS.md`).

`node packages/app/test/viewer.mjs`, run from the repo root after `npm run build:app`, loads
the deployed frontend that the PC server serves from `packages/app/build` (default
`https://192.168.1.197:9999`, override with `VIDEO_TEST_ORIGIN`) in headless Chromium
(`/usr/bin/chromium`) with isolated API/media fixtures. Cases cover midpoint continuity
without scroll writes, immediate settlement, held fingers, continued momentum, directional
spacer landings, reversal and list boundaries, native URL history, progress persistence,
marker reset, mute, and seeking. Non-GET requests are blocked; no real edits or
download-list changes occur.

Both are behavioral regression tests, not proof of physical iPhone momentum or native HLS
playback; those still need an on-phone check.
