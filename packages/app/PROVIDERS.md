# Shared video frontend and online-provider content scripts

The list, stylesheet, overlay, player units, timeline and gestures in `src` are
the implementation for the local website and the online apps Xvid (XVideos), Ptrex
(Porntrex) and Tango (tango-live). Each app injects a content script that bundles
exactly one online provider: `src/content/<provider>.ts` starts the shared `boot.ts`
takeover with that provider and its hosts.

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
Otherwise retain the full title. Both online providers share this rule
(`providers/uploadTitle.ts`). Page URLs remain navigation. Signed media sources are resolved only when a player unit needs
them and are never stored in the catalog. HLS uses the existing full-master,
highest-resolution selection; MP4-only videos use their existing high/low
sources. Online native playback uses media duration, while PC HLS retains its
authoritative segment timeline for editing and live finalization.

Duration comes from the paragraph immediately following `.title` in each upload
row. File sizes are estimates: XVideos uses 4 Mbps (500,000 bytes/second), and
local providers retain their existing 2.3 Mbps estimate. Unknown duration uses
the shared frontend's existing placeholders.

## Porntrex

Porntrex consumes the signed-in account's `/my/videos/` list
(`#list_videos_my_uploaded_videos`, rows by `data-item-id`, title in `p.inf a`,
duration in `.durations`). Signed-out member pages redirect to the home page;
that redirect or a password form sends the viewer to the native `/login/` page,
which polls until the session exists and then returns to the list. Pagination is
not implemented yet: the account had two uploads, so its format was unobservable.
If the heading's `My Videos (N)` exceeds the parsed rows, a console warning says so.

Video pages expose plain player flashvars (`video_url`, `video_alt_url`,
`video_alt_url2`…) with `<key>_text` labels; playback uses the highest labelled
resolution as MP4 (`/get_file/`), resolved only when a player needs it and never
stored. Sizes use the same 4 Mbps estimate as XVideos. The site's `kt_member`
remember-me cookie (about 30 days) keeps the login, so Ptrex has no background
worker and requests no cookie/webRequest permission.

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
npm run build:content -- xvideos
npm run build:content -- porntrex
npm run build:content -- tango-live
npm exec -w app -- playwright-core install webkit
npm run test:app:webkit
```

The content-script builder requires exactly one supported provider. Its output is
`dist/content/<provider>`, separate from the website's `packages/app/build`.
The Vite provider-registry alias selects local adapters for the website and only
the chosen online provider for each content script. No backend/downloader/pipeline build is needed.

WebKit fixtures cover Porntrex listing, labels, durations, highest MP4 quality,
Back, signed-out login return and document-start takeover; for XVideos,
incremental/recovering pagination, duration/size, highest
quality, progress, Back/reload, native login/management, absence of PC requests, all three local providers, and shared scroll settlement.
They do not establish physical iPhone momentum or native HLS playback.
Inspect the installed apps with ios-tools' inspector (see `apps/ios/PORT.md`); use
the shared Mac access runbook at `/home/visar/Documents/environment/mac-access.md`.

## iPhone packaging

The XVideos, Porntrex and tango-live content scripts run in the **Xvid**, **Ptrex**
and **Tango** apps (`apps/ios`, see its `PORT.md`): `apps/ios/scripts/deploy.py
<provider> sync` runs `build-content.mjs` and stages `content.js` for the app.
