# Video Frontend Rewrite

## Status

This document records the agreed direction for rewriting `packages/app`. It is the
source of truth for the rewrite unless a later decision explicitly supersedes it.

The rewrite replaces the Svelte SPA/PWA shell with a pure TypeScript frontend and
delegates navigation, history, scrolling, and page restoration to Safari wherever
possible.

Implementation status (2026-07-29): the rewrite is implemented in
`packages/app/src`. The unchanged former Svelte source is retained in
`packages/app/src_old` as reference and is excluded from the build.

## Goals

- Preserve the two core responsibilities of the application:
  - Editing recordings.
  - Managing provider download lists.
- Use normal Safari documents, tabs, history, scrolling, and back gestures.
- Make the list and viewer separate browser history entries.
- Keep vertical video navigation inside the viewer without adding history entries.
- Remove application state that duplicates browser state.
- Keep the downloader, server, and frontend ownership boundaries independent.
- Prefer server-confirmed UI state over optimistic UI.

## Non-goals

- Do not redesign the downloader or couple recordings to downloader metadata.
- Do not add provider IDs to filenames.
- Do not add a `sourceId` or similar field to `Video`.
- Do not migrate historical recording identities.
- Do not rewrite the mature HLS, playlist-timeline, or editing rules without a
  concrete reason.
- Do not preserve features merely because they exist in the current frontend.

## Technology

- Remove Svelte and SvelteKit from `packages/app`.
- Use TypeScript, Vite, CSS, browser DOM APIs, and `hls.js`.
- Keep the existing Express static-file serving and frontend route fallback.
- Use pathname-based route dispatch, following the structure of
  `/home/visar/Documents/work/video/stream-viewer`.

Suggested source layout:

```text
packages/app/
  index.html
  src/
    main.ts
    style.css
    core/
      page.ts
      navigationState.ts
      lifecycle.ts
    routes/
      videoList.ts
      videoViewer.ts
      textEditor.ts
    list/
      ListView.ts
    player/
      PlayerUnit.ts
      VideoEngine.ts
      GestureController.ts
      OverlayView.ts
      PlaybackTimeline.ts
    services/
      api.ts
      downloadList.ts
      hls.ts
      videoActions.ts
```

The exact file names may change. The ownership boundaries should not.

## PWA removal

Remove all PWA support:

- Web app manifest and manifest link.
- Service worker and normal service-worker registration.
- Standalone Apple web-app metadata.
- Install-only icons where they have no remaining favicon purpose.
- Standalone-PWA viewport/orientation workarounds.
- PWA-specific decisions, comments, and code paths.

HTTPS remains useful and is not PWA support. The existing certificate directory
name does not by itself require an operational change.

## Routes and native navigation

Use distinct list and viewer URLs:

```text
/videos/:provider
/videos/:provider/:encodedFilename?type=original
/videos/:provider/:encodedFilename?type=edited
```

The precise encoding may be adjusted, but a deep link must identify the requested
video without depending on in-memory state.

Each list row is a real anchor. Clicking it:

1. Does not call `preventDefault()`.
2. Performs normal document navigation to the viewer URL.

There is no client-side `goto()`, SPA route transition, or list/video visibility
toggle.

Provider switching is not an application swipe. Each provider has its own URL,
and Safari tabs are used when multiple providers should remain open. The URL is
the provider authority; there is no selected-provider application state.

## Browser history

Opening a video creates one native history entry after the list:

```text
list -> video
```

Vertical navigation between videos updates the active viewer and calls:

```ts
history.replaceState(null, "", nextVideoUrl);
```

It must never push an entry per video. After any number of vertical video changes,
Safari Back returns directly to the frozen list.

Remove the custom edge-back gesture, list-return animation, and `showList()` state
transition. A leading-edge horizontal gesture belongs to Safari:

- Do not classify it as seek.
- Do not call `preventDefault()`.
- Do not transform the viewer.

## List

Render the complete list as ordinary DOM. Remove virtualization:

- No fixed item-height calculations.
- No spacer element.
- No visible slice.
- No translated row container.
- No scroll-derived render state.

Safari owns list scrolling and scroll restoration. Do not save, restore, align, or
correct list scroll position. Returning from the viewer only highlights the last
viewed row; it does not scroll to it.

The list row remains a native anchor and displays the existing useful metadata:

- Filename.
- Duration.
- Estimated size.
- Live/original/edited styling.
- Last-viewed highlight.

If full-list DOM size becomes a measured problem at much larger data volumes,
revisit it based on evidence. Do not carry virtualization into the rewrite
speculatively.

## Remove filtering

Remove the recording filter and all frontend-only alias grouping:

- Filter dropdown.
- Selected filter chips.
- Filter counts.
- Manual linking and unlinking of filter groups.
- Long-press/context-menu filter management.
- Filter-specific identity groups.
- Disjoint-set grouping.
- Selected-alias state.
- Manual filter links in `localStorage`.
- Filtered video sequences.

Viewer navigation uses the complete provider video ordering fetched by the viewer.

This removal does **not** remove provider identity resolution or download-list
management. Those are separate, core responsibilities.

Safari Find on Page is an acceptable occasional way to find a visible recording.
If a real need later appears, add a simple substring search rather than restoring
linked alias groups.

## Viewer startup and list highlight

There is no list-to-viewer video-list handoff. The viewer URL contains the
provider and requested video identity. On every viewer document startup:

1. Fetch the complete provider video list explicitly.
2. Find the URL video.
3. Use the fetched ordering for vertical navigation.
4. Show a clear not-found state if the requested video no longer exists.

This keeps the list row as an ordinary anchor and avoids copying server list state
through `sessionStorage`.

The viewer writes one per-provider highlight value to `sessionStorage`:

```ts
sessionStorage.setItem(`video-highlight:${provider}`, currentVideo.filename);
```

Write it on viewer startup and after a committed vertical navigation. Filename is
enough because it remains stable when a recording moves between original and
edited. The value exists only so the restored list can apply the usual highlight;
it contains no videos, type state, membership, scroll position, or other server
state.

## bfcache and page lifecycle

The list document should be eligible for bfcache:

- Do not register `unload` or `beforeunload` handlers.
- Use `pagehide`, `pageshow`, and `visibilitychange` where lifecycle handling is
  necessary.
- Avoid cleanup that destroys a page merely because it entered bfcache.

The list route owns exactly one poller. Its lifecycle is explicit:

- After the initial list fetch succeeds, start polling.
- On `pagehide`, stop polling and clear its timer before the document enters
  bfcache or leaves the page.
- On a bfcache `pageshow`, keep polling stopped while performing the explicit
  authoritative refresh.
- After that refresh settles, start one new poller.
- Starting an already-running poller must be a no-op or replace the existing
  timer, so repeated lifecycle events cannot create duplicate intervals.

On:

```ts
pageshow
```

with:

```ts
event.persisted === true
```

start an explicit authoritative refresh immediately:

- Refetch videos.
- Reconcile added, removed, edited, original, and live rows.
- Read the per-provider filename and reapply the last-viewed highlight.

Never call `scrollTo()` during this process.

The bfcache refresh does not wait for, depend on, or get delegated to the periodic
poller. Safari first reveals the frozen list, and the `pageshow` handler issues
the refresh requests immediately so the restored DOM converges to server truth as
soon as their responses arrive.

Polling has one separate purpose: while the list remains open, discover newly
created videos and append them promptly. It is not the correctness mechanism for
returning from bfcache. The explicit restore refresh happens first; polling resumes
afterward as a distinct lifecycle step.

## Viewer and gestures

Retain the three-slot player carousel:

- Previous video.
- Current video.
- Next video.

Each slot is one indivisible player unit. A player unit owns:

- Its wrapper element.
- Its video element.
- Its complete overlay DOM and overlay controller.
- Its playback timeline.
- Its loaded-video identity.
- Its slot-specific media/HLS resources and event handlers.

The video and overlay are children of the same unit wrapper. All vertical peek,
commit, cancel, and reset transforms apply to that wrapper, never to the video and
overlay separately. They therefore move on and off screen as one item.

There is no shared overlay, no overlay outside the unit DOM, no reparenting an
overlay between videos, and no binding one overlay controller to a different unit.

As in Stream Viewer, the carousel keeps three permanent unit objects and rotates
their positional roles after a committed vertical navigation. The outgoing unit
may later be cleared and loaded with the new adjacent video, but its video and
overlay remain together for the entire unit lifetime. "Reuse" always means reuse
of the complete unit; its parts are never reused independently.

Preserve the existing ownership decisions around per-unit state and playlist
authority.

Retain:

- Vertical next/previous navigation and peek.
- Horizontal seek away from Safari's leading-edge navigation region.
- Progress-bar scrubbing.
- Cut markers.
- Pinch zoom if it remains desired.
- Horizontal control reveal/hide if it remains useful.
- Native HLS and `hls.js` behavior.
- Resume, network recovery, wake lock, and bounded progress persistence.

Remove:

- Provider swipe.
- Custom edge-back.
- List-return animation.
- Full application touch ownership.
- PWA-specific gesture suppression.

Prevent default only after a gesture has been classified as application-owned.

## Remove watchdog and frontend logging

Remove `WatchdogService` and the background sentinel timer. They infer a browser
freeze from delayed `setInterval` ticks and call `engine.resume()`. This was a
PWA-era recovery heuristic and should not survive the rewrite.

Keep direct lifecycle behavior:

- Force-save progress when the viewer becomes hidden or receives `pagehide`.
- On a real transition back to visible state, ask the engine to resume/reconcile
  playback.
- On `pageshow`, reconcile the viewer if Safari restored it.
- On `online`, ask the engine to recover if the active stream needs it.

These actions respond to browser events. Do not run timer-drift watchdogs,
sentinels, or parallel freeze detectors.

Remove the frontend logging pipeline:

- `LogService` and the older `logEvent` helper.
- Typed frontend log-event unions.
- Per-event `POST /api/log` requests.
- Global error and unhandled-rejection forwarding.
- Navigation, gesture, unit, media, timeline, edit, and recovery log emissions.
- The server `/api/log` passthrough route when no frontend caller remains.

Normal server/downloader logging for API operations, file mutations, downloads,
and failures remains. Browser `console.error`/`console.warn` may still be used at
the point of an unexpected error, but there is no frontend logging service or
persistent frontend forensic event history.

Removing the timeline/edit log emissions does not remove their underlying
playlist authority, calculations, verdicts, or error handling. Existing decisions
that require particular frontend diagnostic events are superseded for this
rewrite and should be updated when the rewrite lands.

## Player unit and overlay without Svelte

Create one `PlayerUnit` per carousel slot. Its constructor creates the wrapper,
video, and `OverlayView`, appends the video and overlay into the wrapper, and owns
them until the whole viewer is destroyed.

`OverlayView` is an internal part of its `PlayerUnit`, not an independently pooled
or shared view. Build its DOM once and retain references to elements that change.

The engine updates explicit fields such as:

- Video name and type.
- Current time and duration.
- Progress width.
- Current segment.
- Live state.
- Mute state.
- Active state.
- Cut markers.
- Button state.

Do not replace the full overlay DOM on every media event. Continue the existing
bounded update rate for time-related UI. Carousel animations transform the
`PlayerUnit` wrapper so all of this UI moves with its matching video.

## Editing: preserve behavior

Editing is core and must retain current semantics:

- Save an original recording as edited.
- Create edited output from paired WYSIWYG cut markers.
- Return edited recordings to originals.
- Preserve playlist timeline authority.
- Preserve segment-name calculation and playback-to-playlist mapping.
- Preserve native-ended classification.
- Preserve missing-video handling.
- Preserve progress saving and viewer reload after edits.

The rewrite may change UI plumbing, not the established editing ownership rules in
`decisions.md`.

After a confirmed edit mutation, update the viewer's local video representation.
The filename highlight does not change. The restored list explicitly refetches
authoritative server state on bfcache activation.

## Download-list identity boundary

Download-list management is core and must remain provider-aware on the server.

The recording filename remains:

```text
timestamp + capture-time alias
```

Do not append provider IDs. The downloader and video application remain
independent; no recording sidecar or shared downloader metadata is introduced.

The frontend extracts the capture-time identifier from the filename and sends it
to the provider download-list API. Provider adapters own interpretation:

- Tango resolves the alias through current/historical alias knowledge to the
  account ID. Tango aliases are unique at a point in time but may be reused after
  an account closes. This ambiguity is accepted and can be corrected with the
  frontend remove button.
- FC2 uses the channel ID as both filename label and stable identifier.
- SC resolves the username to its room ID; username-change limitations remain
  provider-adapter concerns.

Keep:

- `/api/:provider/list`.
- `/api/:provider/add`.
- `/api/:provider/remove`.
- Provider text editors.
- Tango alias registry and history.
- SC room-ID resolution and alias refresh.
- FC2 channel-ID handling.

## Server-confirmed membership state

Do not optimistically flip the add/remove icon and roll it back after failure.
The UI must distinguish confirmed state from an in-progress operation.

Use an explicit state machine per active video:

```ts
type MembershipState =
  | { state: "loading" }
  | { state: "ready"; isMember: boolean }
  | { state: "adding"; confirmedMember: false }
  | { state: "removing"; confirmedMember: true }
  | { state: "error"; confirmedMember: boolean; message: string };
```

Behavior:

- `loading`: show a loading indicator; disable the action.
- `ready`: show add or remove based on confirmed server membership.
- `adding`: show a pending/loading icon; disable repeated actions.
- `removing`: show a pending/loading icon; disable repeated actions.
- `error`: retain the last confirmed membership presentation, expose failure
  feedback, and allow retry.

Mutation sequence:

1. Begin from a confirmed `ready` state.
2. Enter `adding` or `removing`.
3. Send the request.
4. On success, refetch provider membership or otherwise obtain an authoritative
   resulting membership from the server.
5. Enter `ready` only with the confirmed result.
6. On failure, enter `error` with the previous confirmed value.

The viewer must not claim that membership changed before the server confirms it.
Only one membership mutation may be in flight for the active video. Stale async
responses must not update a different video after vertical navigation; use an
operation token, video key check, or `AbortController`.

## State ownership

Remove global SPA stores. State is local to the active document and route.

List route owns:

```ts
interface ListState {
  provider: Provider;
  videos: Video[];
  highlightedFilename: string | null;
}
```

Viewer route owns:

```ts
interface ViewerState {
  provider: Provider;
  videos: Video[];
  currentIndex: number;
  activeSlot: number;
  segments: number[];
  controlsVisible: boolean;
  startTimeOverride: number | null;
  membership: MembershipState;
}
```

The URL owns provider and current viewer identity. Safari owns history, tabs,
scroll, and back navigation.

## Modules to preserve and adapt

Preserve rather than reimplement where practical:

- `VideoEngine`.
- `PlaybackTimeline`.
- HLS parsing and edit calculations.
- API request functions.
- Provider download-list APIs.
- Formatting utilities.
- Adjacent-video navigation.
- Direct browser lifecycle and connectivity handling.

Adapt:

- `VideoEngine` to operate on complete `PlayerUnit` objects and update each
  unit's internal `OverlayView` rather than Svelte state.
- `GestureController` to plain fields/callbacks and native Safari edge ownership.
- Video actions to route-local viewer state.
- Connection lifecycle to the viewer document.

Delete:

- Svelte components and stores.
- SvelteKit routing.
- Provider swipe action.
- List virtualization.
- Filter and manual filter alias grouping.
- SPA list/video view state.
- Scroll anchors and scroll correction.
- PWA support.
- Watchdog and sentinel freeze detection.
- Frontend logging services, emissions, and `/api/log` passthrough.

## Implementation sequence

Keep navigation/framework work separate from player-domain changes:

1. Create the pure TypeScript/Vite shell and pathname router.
2. Remove PWA assets, metadata, and registration.
3. Implement full native provider list with real anchors.
4. Implement viewer startup from its URL plus the per-provider filename highlight.
5. Implement bfcache list refresh without scroll correction.
6. Port the three-slot viewer while preserving `VideoEngine` and
   `PlaybackTimeline`.
7. Port each complete video-plus-overlay subtree as an indivisible `PlayerUnit`;
   use one internal imperative `OverlayView` per unit.
8. Port gestures, leaving Safari's leading edge unowned.
9. Port editing actions and verify existing timeline behavior.
10. Port download-list management with the server-confirmed membership state
    machine.
11. Port the provider text editors.
12. Remove old Svelte/SvelteKit/filter/virtualization, watchdog, sentinel, and
    frontend logging code and dependencies.
13. Build, type-check, and test against the managed services.
14. Verify directly on iPhone Safari:
    - Native list scrolling.
    - Native list-to-viewer navigation.
    - Native back swipe to the frozen list.
    - No scroll correction.
    - Correct highlight after return.
    - Immediate bfcache list refresh after editing, removal, live-state, and new-video
      changes.
    - Polling stops on `pagehide`, remains stopped during restore refresh, and
      resumes exactly once afterward.
    - Vertical viewer navigation using `replaceState`.
    - Safari edge-back does not become seek.
    - Editing and download-list state-machine behavior.

## Acceptance criteria

- The frontend contains no Svelte/SvelteKit or PWA support.
- The frontend contains no watchdog, sentinel timer, or persistent logging
  pipeline.
- All videos are rendered as normal list DOM.
- There is no recording filter or manual frontend alias grouping.
- Provider changes are normal URL/tab navigation, not swipes.
- List row clicks perform native document navigation.
- Safari Back returns from any vertically navigated video to the prior frozen
  list.
- Vertical video navigation replaces, never pushes, viewer history.
- Safari restores list scroll position without application correction.
- The restored list refetches and reflects edits, removals, live changes, and new
  videos.
- The list owns no polling timer while frozen in bfcache and owns exactly one
  polling timer after restoration.
- Only normal highlighting is applied; no highlighted-row scrolling occurs.
- Editing retains current playlist/timeline semantics.
- Download-list buttons show confirmed membership, explicit pending state, and
  recoverable errors.
- Downloader, server, and frontend remain independent at the recording identity
  boundary.
