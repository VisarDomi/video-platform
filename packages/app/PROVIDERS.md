# Shared video frontend and online-provider content scripts

The list, stylesheet, overlay, player units, timeline and gestures in `src` are
the implementation for the local website and the online apps Video Vault (XVideos
and Porntrex; it replaced Ptrex, and Xvid was retired) and Tango (tango-live). Each app injects a
content script that bundles its online provider: `src/content/<provider>.ts` starts the
shared `boot.ts` takeover with that provider and its hosts.

Provider adapters declare `kind: local | online`. Local adapters for Tango/fc2/sc
retain PC HLS, save/cut/return and download-list APIs. Online adapters expose
listing, page URLs, login and playback sources. The shared overlay hides the PC
editing controls for online providers; online playback makes no PC requests.

XVideos consumes the signed-in account's `/account/uploads` pages in site order.
The first page renders immediately, and later pages append without replacing
existing rows. A session catalog carries its unfinished cursor between list and
video documents. Hidden pages abort their work. Later-page failures retain the
cursor and retry; Safari Back reconciles the catalog into the existing list.
Reload fetches a new list. Native account/login, OAuth and upload-management
pages remain usable.

Stable upload IDs identify progress. When bracketed title text contains a timestamp
such as `2026-01-20 140639`, display only that bracket's contents, without brackets.
Otherwise a timestamp elsewhere in the title starts the label (`String panty 2026-07-13
162147 AI_channel` shows `2026-07-13 162147 AI_channel`); titles without one stay whole.
Page URLs remain navigation. Signed media sources are resolved only when a player unit needs
them and are never stored in the catalog. HLS uses the existing full-master,
highest-resolution selection; MP4-only videos use their existing high/low
sources. Online native playback uses media duration, while PC HLS retains its
authoritative segment timeline for editing and live finalization.

Duration comes from the paragraph immediately following `.title` in each upload
row. File sizes are estimates: XVideos uses 4 Mbps (500,000 bytes/second), and
local providers retain their existing 2.3 Mbps estimate. Unknown duration uses
the shared frontend's existing placeholders.

Both upload sites are built on `providers/uploadSite.ts`: same-origin page reads,
upload rows and labels, durations (clock or `1 h 2 min` text), the playback page,
the streamer for the +/- button and the login wait. Each site supplies only its list
paging, sign-in check and media sources. Links to other sites in a row or the pager
are skipped rather than failing the list. A site read from another site's page (Video
Vault reads XVideos on porntrex.com) uses its own origin and the app's reader.

## Download list on uploads (Video Vault)

As in Tango, the overlay's +/- button adds or removes a streamer in a PC download list.
The streamer is the recording folder's name in the label (`YYYY-MM-DD HHMMSS <streamer>`,
the identifier the local apps' +/- uses; never the video page's own title, where XVideos
turns `_` into spaces). An upload can be any provider's recording, so the button asks all
three lists whether the streamer is in one (➖ if any is). ➕ asks the three providers at
once, through the PC (`GET /api/<list>/exists`), who has a streamer by that name: one hit
adds to that list at once (a wrong guess is undone by unfollowing), several give way to
buttons for just those providers until one is picked (the video playing shows whose it is),
none shows 🔍 (a renamed streamer the provider no longer knows by the recorded name cannot be
added), and a provider that cannot answer shows ⚠️, never a miss. ➖ for a streamer in
several lists asks which one the same way.

The content script asks its app for these requests, as the live extensions ask their
background page: `window.webkit.messageHandlers.downloadList` (`apps/ios`
`VideoApp/DownloadList.swift`). Uploads without a timestamped label have no button, nor
does the content script outside the app (no handler).

## Download-list button

`player/DownloadListButton.ts` is the one +/- button, with its states (⏳ while
checking or changing, ➕/➖, ⚠️ with the reason as tooltip when the list cannot be
read, a yellow ring when a change failed) and the membership check that confirms a change.
Membership is asked by name and answered by the server by ID (`GET /api/<list>/member`), so
a streamer recorded under a name from before a rename (an old Tango alias, a renamed
Stripchat username) still shows ➖. The
viewer (local apps, Tango, Video Vault) and the FC2/SC live extensions' bar
(`packages/live-extensions`) both use it; each only says how to reach the list
(`services/downloadList.ts` for the viewer). Its styles are `player/buttons.css`, part
of `style.css` and bundled into the extensions. It imports nothing else from the app.

## Porntrex

Porntrex consumes the signed-in account's `/my/videos/` list
(`#list_videos_my_uploaded_videos`, rows by `data-item-id`, title in `p.inf a`,
duration in `.durations`), 30 per page; later pages are the list's own async block
(`from_my_videos=N`), followed only when a page links the next one. Signed-out member
pages redirect to the home page.

Video pages expose plain player flashvars (`video_url`, `video_alt_url`,
`video_alt_url2`…) with `<key>_text` labels; playback uses the highest labelled
resolution as MP4 (`/get_file/`), resolved only when a player needs it and never
stored. Sizes use the same 4 Mbps estimate as XVideos. Porntrex keeps one session per
account and the newest login signs the others out, so the phone shares the pipeline's
session (`npm run ptrex:connect-iphone`) and never logs in itself.

## Video Vault

Video Vault (`vault`, the iPhone app that replaced Ptrex) shows both sites' uploads in
one list, oldest recording first by the timestamp in each label (labels without one go
last). It lives on porntrex.com: XVideos' security policy (`default-src` with only its
own and ad hosts) blocks media from other sites, so an xvideos.com page cannot play
Porntrex, while Porntrex sends no policy and XVideos' CDN allows other origins. Its pages
are `/video-vault/` (the list) and `/video-vault/<site><the site's video path>`; Porntrex
answers both with its 404 page, which the script takes over whether or not either site is
signed in. Other Porntrex pages, such as a restored Ptrex tab's `/my/videos/` or
`/video/…`, open their vault page.

Porntrex pages are read directly. XVideos pages cannot be (it allows no other origins), so
`uploadSite` reads a site the document is not on through the app:
`window.webkit.messageHandlers.vaultSite.postMessage({site, path})` answers
`{status, url, text}` from a hidden xvideos.com web view with the same cookies
(`apps/ios` `VideoApp/SiteWorker.swift`). XVideos media plays from its CDN.

Both sites' pages load together. The list opens with the last complete list
(`localStorage` `video-catalog:vault:complete`) and reloads both sites behind it: rows read
so far join the earlier ones, and when the reload finishes only listed uploads remain.
Both sites number their uploads, so filenames are `<site>-<id>`. When the same recording
(timestamp and streamer) is on both sites, its rows say `Xvid` or `Ptrex`.

A signed-out site keeps its earlier rows and shows a notice above the list. XVideos links
its `/account` login page, which returns to the vault once signed in. Porntrex asks for
`npm run ptrex:connect-iphone` instead: logging in on the phone would sign the pipeline out.

## Tango live

`tango-live` (formerly Stream Viewer's Tango provider) is an online provider for live
streams on tango.me: followed streams first, then recommendations, one per streamer, with
blocked streamers hidden and names from profiles. Videos are streamers (`filename` is the
streamer ID, `pageUrl` the `/stream/<id>` page); stream playlists are kept per tab in
sessionStorage. Its `live` actions renew the session (refresh with the account/session IDs
the Tango app supplies) and the 5-second playback tokens, follow/unfollow, block (after
unfollowing) and look up co-streamers. The overlay shows Follow, the PC Tango download
list (+/-, by streamer, at `https://192.168.1.197:9999`) and a two-step Block, without a
timeline, seeking or Multi. As in Stream Viewer, co-streamers join the bottom of the list
once per streamer, and a stream that errors or plays without a picture leaves the list with
the next one taking its place (the first one if it was never listed). Otherwise it follows
the shared viewer's behavior. It runs only in the Tango app (`apps/ios`).

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

The content-script builder requires exactly one supported provider. Its output is
`dist/content/<provider>`, separate from the website's `packages/app/build`.
The Vite provider-registry alias selects local adapters for the website and only
the chosen online provider for each content script. No backend/downloader/pipeline build is needed.

WebKit fixtures cover the download-list button through the app (Video Vault: choosing a
list from the providers' hits, 🔍, ⚠️ for a failed lookup or an unreachable PC, a failed
change) and in the FC2 live extension's bar;
for Video Vault, both sites in one list (XVideos through a stand-in for the app's reader),
order, labels, marks, durations, HLS and MP4 across sites, restored routes, the kept list,
signed-out notices, the XVideos login return and the takeover of Ptrex pages; Tango live;
all three local providers, and shared scroll settlement.
They do not establish physical iPhone momentum or native HLS playback.
Inspect the installed apps with ios-tools' inspector (see `apps/ios/PORT.md`); use
the shared Mac access runbook at `/home/visar/Documents/environment/mac-access.md`.

## iPhone packaging

The vault and tango-live content scripts run in the **Video Vault** and **Tango** apps (`apps/ios`, see its `PORT.md`): `apps/ios/scripts/deploy.py
<provider> sync` runs `build-content.mjs` and stages `content.js` for the app.
