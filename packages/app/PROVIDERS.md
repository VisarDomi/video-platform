# Shared video frontend and XVideos extension

The list, stylesheet, overlay, player units, timeline and gestures in `src` are
the implementation for both the local website and the XVideos Safari extension.
The extension does not use Stream Viewer's list/player/CSS.

Provider adapters declare `kind: local | online`. Local adapters for Tango/fc2/sc
retain PC HLS, save/cut/return and download-list APIs. Online adapters expose
listing, page URLs, login and playback sources. The shared overlay hides the PC
controls for online providers; online playback makes no PC requests.

XVideos consumes the signed-in account's `/account/uploads` pages in site order.
The first page renders immediately, and later pages append without replacing
existing rows. A session catalog carries its unfinished cursor between list and
video documents. Hidden pages abort their work. Later-page failures retain the
cursor and retry; Safari Back reconciles the catalog into the existing list.
Reload fetches a new list. Native account/login, OAuth and upload-management
pages remain usable.

Stable upload IDs identify progress. When bracketed title text contains a timestamp
such as `2026-01-20 140639`, display only that bracket's contents, without brackets.
Otherwise retain the full title. Page URLs remain navigation. Signed media sources are resolved only when a player unit needs
them and are never stored in the catalog. HLS uses the existing full-master,
highest-resolution selection; MP4-only videos use their existing high/low
sources. Online native playback uses media duration, while PC HLS retains its
authoritative segment timeline for editing and live finalization.

Duration comes from the paragraph immediately following `.title` in each upload
row. File sizes are estimates: XVideos uses 4 Mbps (500,000 bytes/second), and
local providers retain their existing 2.3 Mbps estimate. Unknown duration uses
the shared frontend's existing placeholders.

## Build and verify

From the video-platform root:

```sh
npm ci
npm run check -w app
npm run build:app
npm run build:extension -- xvideos
npm exec -w app -- playwright-core install webkit
npm run test:app:webkit
```

The extension builder requires exactly one supported provider. Its output is
`dist/extension/xvideos`, separate from the website's `packages/app/build`.
The Vite provider-registry alias selects local adapters for the website and only
XVideos for the extension. No backend/downloader/pipeline build is needed.

WebKit fixtures cover incremental/recovering pagination, duration/size, highest
quality, progress, Back/reload, native login/management, worker cookie persistence,
absence of PC requests, all three local providers, and shared scroll settlement.
They do not establish physical iPhone momentum or native HLS playback.
`test/iphone-xvideos.py` inspects the installed extension through the paired Mac
without exposing authentication or signed source URLs. Use the shared Mac access
runbook at `/home/visar/Documents/environment/mac-access.md`.

## iPhone packaging

Keep `stream-viewer` and `video-platform` as sibling checkouts with dependencies
installed. From stream-viewer, `npm run build:ios -- tango --prepare-only` invokes
the video-platform XVideos builder and packages its output into Tango's existing
`com.visar.Tango.paid.Xvid` extension. Tango's native reader and Login helper stay
owned by stream-viewer. See its `apps/ios/PORT.md` for signing/install/renewal.

XVideos and future Porntrex remain Safari extensions inside Tango. Porntrex is
deferred to a second pass. The five standalone provider apps and online native
authentication are deferred; no new app or extension identity is introduced here.
