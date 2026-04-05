# Monorepo Decisions

## Ownership: Video is a self-contained unit (2026-04-05)

Every piece of state about a video belongs to the video itself. The `Video` type carries `provider` alongside `filename`, `type`, `duration`, `size`, `isLive`. Operations derive context from the video object — no threading `provider` through function args from external stores.

**Backend:** `VideoRef` (`filename`, `provider`, `type`, `dirPath`) is resolved once at the API boundary via `resolveVideo(filename, provider)`. Services receive the ref, never re-resolve. No cross-provider directory search — `findVideoPath()` (global 12-dir search) was replaced with provider-scoped resolution.

**Frontend:** `fetchVideos` stamps `provider` on each video at fetch time. `playerStore`, `videoActions`, `VideoEngine`, and `hls.ts` read provider from the video itself.

**Why:** The old `findVideoPath()` searched all providers. A tango video could match an fc2 path. The frontend threaded `videoListStore.selectedProvider` through 5 layers of function calls — fragile and easy to desync.

## Ownership: Per-unit UI overlay via Svelte 5 mount() (2026-04-05)

Each of the 3 carousel player slots is a self-contained unit: a wrapper div containing a `<video>` element and a `PlayerOverlay.svelte` instance mounted via Svelte 5's `mount()` API. The overlay (name, progress bar, controls) is a child of the unit's DOM — it moves with the video during peek swipe.

**Pattern:** `PlayerOverlayState.svelte.ts` is a `$state` class. The engine writes to each unit's state (currentTime, duration, video, isMuted, isActive). The mounted Svelte component reads reactively.

**Why:** The old architecture had one shared overlay separate from the video elements. During peek swipe, the overlay required manual transform sync, hide/show coordination, and caused UI jank (stale data flash on navigation commit). The tango userscript's `StreamUnit` pattern proved that each slot should own its complete UI.

## Ownership: Each unit feeds its own state (2026-04-05)

Each unit's `timeupdate` handler writes to its own `PlayerOverlayState` at 4Hz, regardless of active/inactive status. Preloaded units show real time/duration data during peek.

The active-only gate remains for: localStorage progress save (global), engine's gesture-facing fields (`_currentTime`, `_duration`, `_seekableEnd`).

**Why:** The old active-only gate was from the shared-overlay era where only one set of time values existed. With per-unit state, each unit should feed its own data.

## Ownership: No shadow state — derive from the slot (2026-04-05)

`VideoEngine` has no `currentFilename` field. Whether a video changed is derived from `unit.video.dataset.loadedFilename` — the actual content loaded in the slot. The slot is the source of truth.

**Why:** The old `currentFilename` shadow field diverged from reality after carousel rotation. Going back to list and re-opening the same video showed a different video because `currentFilename` matched but the slot had rotated to different content.

## Typed frontend logging: LogService (2026-04-05)

Discriminated union `LogEvent` type with `LogEmit` type-safe emit function, matching the pattern from manga-reader and gallery-reader. Events cover unit lifecycle (`unit-load`, `unit-activate`), peek gestures (`peek-commit`, `peek-cancel`), playback (`live-status-changed`, `video-removed`), edit actions, and resume/recovery. Sent to server via `POST /api/log`.

**Why:** The old `logEvent(string, data)` had 7 ad-hoc calls and zero coverage of navigation, peek, or player state. Debugging UI issues required asking the user to describe what happened instead of reading logs.

## HLS routes include provider (2026-04-05)

`/hls/:provider/:filename/playlist.m3u8` instead of `/hls/:filename/playlist.m3u8`. The server resolves within the provider's directories only.

**Why:** The old route searched all providers. The frontend already knew the provider but threw it away at the API boundary.

## Cross-process resource ownership

Single writer per resource, no cross-process write contention.

| Resource | Writer | Readers |
|---|---|---|
| `aliases.json` | server (AliasRegistry.refresh, hourly) | server only (frontend via /api/tango/list) |
| `tango.txt` | server (routes + AliasRegistry.syncTangoTxt) | downloader TangoTargetManager |
| `live-status.json` | downloader (DownloadsManager) | server (orphan finalizer) |
| session tokens on disk | auth daemon | server + downloader (shared readTokens()) |
