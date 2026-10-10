# Shared video frontend and online-provider content scripts

The list, stylesheet, overlay, player units, timeline and gestures in `src` are the
implementation for the local website (`main.ts`; providers `tango`, `fc2`, `sc`) and for the
online apps Video Vault (`vault`: XVideos and Porntrex uploads) and Tango (`tango-live`).
Each online app injects a content script that bundles its online provider:
`src/content/<provider>.ts` starts the shared `boot.ts` takeover with that provider and its
hosts. In the iPhone apps (local and online) the list rows open the app's native viewer
instead of the web viewer (`routes/nativeViewer.ts`, see `decisions.md`); Safari keeps the
web viewer.

`boot.ts` runs only on those hosts, on a route the provider recognizes, and not in a window
opened by another page; it starts once per document (`__videoPlatformBoot`). A `login` route
only waits for sign-in. Otherwise it stops the site's page, replaces the document with the
shared list or viewer and, for a live provider, runs `live.start()` first. A sign-in error
sends the page to the provider's `loginUrl`.

Provider adapters declare `kind: local | online`. Local adapters (`providers/local.ts`) use
the PC's HLS, save/cut/return and download-list APIs. Online adapters expose listing pages,
page URLs, login and playback sources. The overlay shows the PC editing controls (save/cut,
return, markers) only for local videos; online playback makes no PC requests, and only the
+/- button reaches the PC download lists.

## Online lists

Online lists load through `services/catalog.ts`. The first page renders as soon as it
arrives and later pages append without replacing existing rows. The catalog
(`sessionStorage` `video-catalog:<provider>`) carries its unfinished cursor between list and
video documents. Hidden pages stop paging. A failed page keeps the cursor and retries (1 s,
doubling up to 30 s); a sign-in error opens the provider's `loginUrl`. Back (bfcache or a
back/forward load) reuses the saved catalog and reconciles it into the existing list; any
other load fetches a new list.

Upload filenames are stable upload IDs, so they identify progress and the highlighted row.
Signed media sources are resolved only when a player unit needs them and are never stored in
the catalog. Online playback takes its timeline from the media; local HLS keeps the PC
playlist's segment timeline for editing and live finalization.

List sizes are estimates from duration: 4 Mbps (500,000 bytes/second) for XVideos, Porntrex
and Video Vault, and 2.3 Mbps for local providers. An unknown duration shows `--:--` and
`-- MiB`; live streams show `LIVE` and no size.

## Upload sites (XVideos and Porntrex)

Both upload sites are built on `providers/uploadSite.ts`: page reads, upload rows and labels,
durations (clock or `1 h 2 min` text), the playback page, the streamer for the +/- button and
the login wait. Each site supplies only its list paging, sign-in check and media sources.
Fetched pages are parsed, never executed. Links to other sites in a row or the pager are
skipped rather than failing the list. A page on the site itself is fetched same-origin; a
site read from another site's page (Video Vault reads XVideos on porntrex.com) uses its own
origin and the app's reader.

Only the pipeline's uploads are listed (`isPipelineUpload`): their title carries the
recording in brackets, `[YYYY-MM-DD HHMMSS streamer]` (a split part adds ` | part N`). The
label is that bracket's contents, without brackets (`Ignored title [2026-01-20 140639 alice]`
shows `2026-01-20 140639 alice`). Older manual uploads (`2023-06-14 155500 [68190398] asahi`)
and uploads renamed to the bare `YYYY-MM-DD HHMMSS streamer` stay on the sites but are not
listed.

### XVideos

XVideos reads the signed-in account's `/account/uploads` pages (rows `[id^="listing-video-"]`,
title link in `.title`, duration after `Duration:` in the paragraph immediately following
`.title`), following the pagination links in site order. A page without rows that shows a
login form is a sign-in error.

Playback uses the player's `setVideoHLS` source, switched from `hls_low.m3u8` to the full
`hls.m3u8` master, and plays its highest-resolution variant. MP4-only uploads use
`setVideoUrlHigh`, else `setVideoUrlLow`.

### Porntrex

Porntrex reads the signed-in account's `/my/videos/` list
(`#list_videos_my_uploaded_videos`, rows by `data-item-id`, title in `p.inf a`, duration in
`.durations`), 30 per page; later pages are the list's own async block
(`from_my_videos=N`), followed only when a page links the next one. Signed-out member pages
redirect to the home page, which is a sign-in error.

Video pages expose plain player flashvars (`video_url`, `video_alt_url`, `video_alt_url2`…)
with `<key>_text` labels; playback uses the highest labelled resolution as MP4, resolved only
when a player needs it and never stored. Porntrex keeps one session per account and the
newest login signs the others out, so the phone shares the pipeline's session
(`npm run ptrex:connect-iphone`) and never logs in itself.

## Video Vault

Video Vault (`vault`) shows both sites' uploads in one list, oldest recording first by the
timestamp in each label (equal timestamps keep their order). It lives on
porntrex.com: XVideos' security policy (`default-src` with only its own and ad hosts) blocks
media from other sites, so an xvideos.com page cannot play Porntrex, while Porntrex sends no
policy and XVideos' CDN allows other origins.

Its pages are `/video-vault/` (the list) and `/video-vault/<site><the site's video path>`;
Porntrex answers both with its 404 page, which the script takes over whether or not either
site is signed in. Every other Porntrex page redirects into the vault: a Porntrex video page
to its vault page, anything else to the list. On xvideos.com, uploads and video pages
redirect to the vault, and `/account` stays native until signed in, then returns to the
vault; other XVideos pages are left alone.

Porntrex pages are read directly. XVideos pages cannot be (it allows no other origins), so
`uploadSite` reads them through the app:
`window.webkit.messageHandlers.vaultSite.postMessage({site, path})` answers
`{status, url, text}` from a hidden xvideos.com web view with the same cookies
(`apps/ios` `VideoApp/SiteWorker.swift`). XVideos media plays from its CDN.

Both sites' pages load together. The list opens with the last complete list (`localStorage`
`video-catalog:vault:complete`) and reloads both sites behind it: rows read so far join the
earlier ones, and when the reload finishes only listed uploads remain. A viewer opened from
its URL alone takes its video from the session list, the kept list or the route itself.
Filenames are `<site>-<id>`. When the same recording (timestamp and streamer) is on both
sites, its rows say `Xvid` or `Ptrex`.

A signed-out site keeps its earlier rows and shows a notice above the list. The XVideos
notice links `https://www.xvideos.com/account`, which returns to the vault once signed in.
The Porntrex notice asks for `npm run ptrex:connect-iphone` instead: logging in on the phone
would sign the pipeline out.

## Download-list button

`player/DownloadListButton.ts` is the one +/- button: ⏳ while checking or changing, ➕/➖, ⚠️
when the list cannot be read or a lookup fails, and a yellow ring with the last confirmed
state when a change fails; the reason is the tooltip. A change is confirmed by asking
membership again. Membership is asked by name and answered by the server by ID
(`GET /api/<list>/member`), so a streamer recorded under a name from before a rename (an old
Tango alias, a renamed Stripchat username) still shows ➖.

The viewer (local apps, Tango, Video Vault) and the FC2/SC live extensions' bar
(`packages/live-extensions`) both use it; each only says how to reach the list
(`services/downloadList.ts` for the viewer). Its styles are `player/buttons.css`, imported by
`style.css` and bundled into the extensions. It imports nothing else from the app.

The viewer reaches the lists as follows:

- Local videos use their own site's `/api/<provider>/member|add|remove`, by the streamer in
  the recording's filename.
- Tango live uses the PC Tango list at `https://192.168.1.197:9999`, by streamer ID.
- Video Vault asks its app, as the live extensions ask their background page:
  `window.webkit.messageHandlers.downloadList` (`apps/ios` `VideoApp/DownloadList.swift`).

### Uploads (Video Vault)

The streamer is the recording folder's name in the label (`YYYY-MM-DD HHMMSS <streamer>`,
the identifier the local apps' +/- uses; never the video page's own title, where XVideos
turns `_` into spaces). An upload can be any provider's recording, so the button asks all
three lists whether the streamer is in one (➖ if any is). ➕ asks the three providers at
once, through the PC (`GET /api/<list>/exists`), who has a streamer by that name: one hit adds
to that list at once, several give way to buttons for just those providers until one is
picked (the video playing shows whose it is), none shows 🔍 (a renamed streamer the provider
no longer knows by the recorded name cannot be added), and a provider that cannot answer
shows ⚠️, never a miss. ➖ for a streamer in several lists asks which one the same way.

A label that does not start with `YYYY-MM-DD HHMMSS <streamer>` has no button, nor does the
content script outside the app (no handler).

## Tango live

`tango-live` is an online provider for live streams on tango.me: followed streams first, then
recommendations, one per streamer, with blocked streamers hidden and names from profiles
(best effort). Videos are streamers (`filename` is the streamer ID, `pageUrl` the
`/stream/<stream ID>` page); stream playlists are kept per tab in `sessionStorage`
(`tango-live-media`) so a reopened or restored stream page plays at once.

Its `live.start()` runs before anything loads: it refreshes the session with the account and
session IDs the Tango app supplies (in Safari, the ones the Tango website stores) and the
playback tokens, then renews the tokens every 5 seconds and on `pageshow`, and the session
every 30 minutes. A missing or rejected session opens `videoapp://login`, the app's Safari
login handoff screen. Its other `live` actions follow/unfollow, block (after unfollowing) and
look up co-streamers.

The overlay shows Follow, the PC Tango download list (+/-, by streamer ID) and a two-step
Block, without a timeline or seeking. Co-streamers join the bottom of the list once per
streamer, and a stream that errors or plays without a picture leaves the list with the next
one taking its place (the first one if it was never listed). Otherwise it follows the shared
viewer's behavior. It is injected only by the Tango app (`apps/ios`).

## Build and verify

From the video-platform root:

```sh
npm ci
npm run check -w app
npm run build:app
npm run build:content -- vault
npm run build:content -- tango-live
npm run build -w live-extensions
npm exec -w app -- playwright-core install webkit
npm run test:app:webkit
```

The content-script builder requires exactly one supported provider (`vault` or
`tango-live`). Its output is `dist/content/<provider>/content.js`, separate from the
website's `packages/app/build`. The Vite provider-registry alias (`@providers`) selects the
local adapters for the website and only the chosen online provider for each content script.
No backend/downloader/pipeline build is needed. `test:app:webkit` reads `packages/app/build`,
`dist/content/<provider>` and `dist/extension/fc2-live`, so build them first.

WebKit fixtures cover the download-list button through the app (Video Vault: one hit adding
at once, choosing a list from several hits, 🔍, ⚠️ for a failed lookup or an unreachable PC, a
failed change) and in the FC2 live extension's bar; for Video Vault, both sites in one list
(XVideos through a stand-in for the app's reader), only pipeline uploads listed, order,
labels, marks, durations, HLS and
MP4 across sites, restored routes, the kept list, signed-out notices, the XVideos login
return and the takeover of Porntrex's own pages; Tango live (list, Follow, +/-, two-step
Block, co-streamers, ended streams); all three local providers; and shared scroll settlement.
They do not establish physical iPhone momentum or native HLS playback.
Inspect the installed apps with ios-tools' inspector (see `apps/ios/PORT.md`); use
the shared Mac access runbook at `/home/visar/Documents/environment/mac-access.md`.

## iPhone packaging

The vault and tango-live content scripts run in the **Video Vault** and **Tango** apps
(`apps/ios`, see its `PORT.md`): `apps/ios/scripts/deploy.py <provider> sync` runs
`build-content.mjs` and stages `content.js` for the app.
