# Website

The list, stylesheet, overlay, player units, timeline and gestures in `src` are the local
website (`main.ts`; providers `tango`, `fc2`, `sc`) that Safari and the PC open. The server
serves its build (`packages/app/build`), so `npm run build:app` needs no restart. The iPhone
apps (the local lists, Video Vault and Tango) are native (`apps/ios`, see its `README.md`);
a change here does not reach them. Rules and their reasons are in `decisions.md`.

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
Tango alias, a renamed Stripchat username) still shows ➖.

The website's viewer and the FC2/SC live extensions' bar (`packages/live-extensions`) both
use it; each only says how to reach the list
(`services/downloadList.ts` for the viewer). Its styles are `player/buttons.css`, imported by
`style.css` and bundled into the extensions. It imports nothing else from the app.

The viewer uses its own site's `/api/<provider>/member|add|remove`, by the streamer in the
recording's filename; the live extensions ask their background page. The native apps have
their own button (`apps/ios` `VideoApp/ViewerOverlay.swift`), with the same states.

## Build and verify

From the video-platform root:

```sh
npm ci
npm run check -w app
npm run build:app
npm run build -w live-extensions
npm exec -w app -- playwright-core install webkit
npm run test:app:webkit
```

`test:app:webkit` reads `packages/app/build` and `dist/extension/fc2-live`, so build them
first. Its WebKit fixtures cover all three local providers (playback and editing controls,
shared scroll settlement) and the download-list button in the FC2/SC live extensions' bar,
including ⚠️ for an unreachable PC. They do not establish physical iPhone momentum or native
HLS playback. The iPhone apps are tested by `apps/ios/scripts/test.sh`; for Mac access use
the runbook at `/home/visar/Documents/environment/mac-access.md`.
