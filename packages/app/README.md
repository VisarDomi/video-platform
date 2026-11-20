# Website

The list, stylesheet, overlay, player units, timeline and gestures in `src` are the local
website (`main.ts`) that Safari and the PC open; its sites are the server's (`GET /api/sites`:
the sites file's capture sites, the first being the default page). The server serves its
build (`packages/app/build`), so `npm run build:app` needs no restart. The iPhone apps are
native (a deployment's own, under `private/`); a change here does not reach them. Rules and their reasons are in `decisions.md`.

Local adapters (`providers/local.ts`) use the PC's HLS, save/cut/return and download-list
APIs. The provider types still allow `kind: 'online'` adapters (listing pages, login,
playback sources, live actions), but none are left; the list, viewer and catalog keep that
path for a future one. The overlay shows the PC editing controls (save/cut, return, markers)
for local videos.

List sizes are estimates from duration at 2.3 Mbps. An unknown duration shows `--:--` and
`-- MiB`.

## Download-list button

`player/DownloadListButton.ts` is the one +/- button: ⏳ while checking or changing, ➕/➖, ⚠️
when the list cannot be read or a lookup fails, and a yellow ring with the last confirmed
state when a change fails; the reason is the tooltip. A change is confirmed by asking
membership again. Membership is asked by name and answered by the server by ID
(`GET /api/<list>/member`), so a streamer recorded under a name from before a rename (an old
alias, a renamed username) still shows ➖.

The website's viewer and the live extensions' bar (`packages/live-extensions`) both
use it; each only says how to reach the list
(`services/downloadList.ts` for the viewer). Its styles are `player/buttons.css`, imported by
`style.css` and bundled into the extensions. It imports nothing else from the app.

The viewer uses its own site's `/api/<provider>/member|add|remove`, by the streamer in the
recording's filename; the live extensions ask their background page. The native apps have
their own button (`private/apps/ios` `VideoApp/ViewerOverlay.swift`), with the same states.

## Build and verify

From the video-platform root:

```sh
npm ci
npm run check -w app
npm run build:app
npm run test:app:pages
```

`test:app:pages` reads `packages/app/build`, so build it first. It drives the system's Chromium (`/usr/bin/chromium`, or `$VIDEO_CHROMIUM_PATH`), never a
browser Playwright downloads; set `WEBKIT_EXECUTABLE_PATH` to run it in a WebKit build instead.
Its fixtures cover the root opening the first site and every site's list (playback and
editing controls, shared scroll settlement). They do not establish physical iPhone momentum
or native HLS playback.
