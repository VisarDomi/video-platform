# Safari extensions hosted by Tango

Two Safari web extensions hosted by the Tango app (`apps/ios`, provider `tango-live`) that
add or remove the open streamer from a PC download list: **FC2 live** (`live.fc2.com`,
`/api/fc2`) and **SC live** (`stripchat.com`, `/api/sc`). On a streamer's page each shows a
fixed top bar with a +/- toggle. The bar shows the website viewer's button: it imports
`DownloadListButton` and `buttons.css` from the `app` workspace (states and styles are
described in `packages/app/README.md`), inside a shadow root so the site's styles and the
button's stay apart. Tango's own +/- is in the app's native viewer
(`apps/ios/VideoApp/ViewerOverlay.swift`).

The existing list server is `SERVER` in `src/core/config.ts`
(`https://192.168.1.197:9999`); Bunkr uses `BUNKR_SERVER` on port `9998`.

**Bunkr to PC** handles video pages at `https://bunkr.si/f/...`, `bunkr.ph/f/...`
and `bunkr.cr/f/...`. It probes the PC from its background page. With a recently
reachable PC, tapping the file's Download button queues the original video in
`~/Videos/plab/bunkr/` and shows its progress on the button. Opening or refreshing
the same file page discovers its existing job by the PC's deterministic ID,
without another tap or submission. A per-tab cache keeps the last confirmed
progress visible during an outage; it says reconnecting until the PC answers.
Foreground, page restoration and network recovery refresh status immediately,
with bounded requests and automatic polling. A lost submission acknowledgement
is resolved by reading the existing job rather than submitting again. Related-file links
and modified clicks keep their normal behavior. When the PC is unavailable,
the site's Download button works normally for a new download. A known active PC
job stays attached during a connection loss, avoiding an accidental duplicate
download on the phone. An explicit retry is idempotent.

On `/a/<id>` it takes over the document at `document_start`, using the same
`window.stop()` / document rewrite boundary as Manga Reader and Stream Viewer.
The page contains only the full album title/totals and a tightly packed file
list. Each row has the full filename, size/date, the `/f/` player's contact-sheet
poster and an adjacent gray PC download/status button. There is no row or image
padding, fixed thumbnail aspect, crop or enlargement. Cached natural image
dimensions reserve the layout before decoding. Safari owns Back navigation.
The details keep their normal text size when they fit; a small resize-driven
measurement shrinks the whole details block only when it is taller than its
thumbnail, and restores the size when room returns. It recalculates after poster
loads, rotation and status changes. CSS controls all font proportions and button
spacing. `text-fit` currently fits line width and is unavailable in Safari, so it
cannot provide this height-based behavior by itself.
The file page's declared `videoCoverUrl` is read as a JSON string; its player and
scripts are never executed by the album. The original small album thumbnail is
retained if the file poster cannot be loaded. Visible/nearby rows fetch posters
and PC status with at most three concurrent requests of each kind; hidden rows
stop polling. Album and file-page buttons share `core/bunkrDownload.ts`, including
refresh restoration, offline progress, explicit retry, and lost-acknowledgement
lookup. Browsing never submits a download. `/f/` keeps its original page layout
and existing native-download fallback when no PC job is known.

The independent `video-bunkr-downloads.service` on HTTPS :9998 resolves Bunkr's numeric metadata and expiring signature itself; Safari
can close after acceptance. `/api/bunkr/health` advertises this capability;
`POST /api/bunkr/downloads` accepts a file-page URL with the extension's
`X-Video-Download: 1` header; `GET /api/bunkr/downloads/:id` reports progress.
Website origins cannot submit work. The server follows only the three Bunkr
domains, their `dl` hosts and Bunkr's `*.cdn.cr` hosts, with bounded metadata
responses. Only video filenames are accepted. The unit is enabled at boot and
systemd restarts it after an unexpected exit. This is an ordinary byte-copy
download, separate from capture and the conversion/description/upload campaign.

Jobs persist outside the checkout in
`~/.local/share/video-services/bunkr-downloads/`. One transfer runs at a time.
Acceptance follows an fsynced atomic job write and directory flush; duplicate
taps share that pending receipt, and a worker cannot start an uncommitted job.
Receipt writes are serialized per video, and accepted FIFO order survives restart. Partial
files have a `.part` suffix, checkpoint every 8 MiB or five seconds with data
flushed before the checkpoint, and recover after abrupt power loss. An
uncommitted tail is retained separately before resuming the last durable prefix.
Resume requires a matching ETag and Content-Range; if the CDN cannot prove the
same bytes, the previous partial stays retained and a fresh copy starts.
Completion requires exact byte length, a file flush and an atomic non-overwriting
publication with directory flushes. A crash between publication and marking the
job complete rejoins the existing complete file. Downloads retry five times
with backoff; a failed job can be retried from the button. No media is cleaned up
automatically, including retained partials. This service does not transcode or
send anything to an upload provider.

FC2 live starts watching at `document_start` and clicks the site's visible Login link
as soon as the parser inserts it, without waiting for DOMContentLoaded, images, or the
download-list bar. It also handles links added later. It follows FC2's `/login/` link with
its return URL, in any site language; signing in on FC2 ID still uses Safari's normal login
page. It clicks once per
tab session, remembered in `sessionStorage` across reloads and return visits to prevent
redirect loops.

## Layout

- `src/core/downloadListBar.ts`: the one shared bar around the viewer's button; providers only classify routes
  (`src/provider/fc2-live.ts`: numeric ID; `sc-live.ts`: username, skipping
  non-streamer pages). The bar re-checks the route every second and hides on other pages.
- `src/extension/<name>.ts` is each content script; `background.ts` performs the
  PC requests (`https://192.168.1.197:9999/api/<fc2|sc>/member|add|remove`), only
  for its own provider, so page security policies never apply.

## Build

```bash
npm run build -w live-extensions            # all three extensions
npm run check -w live-extensions            # type check
node packages/live-extensions/test/bunkr.mjs # mobile WebKit + background fixtures
node packages/live-extensions/test/bunkr-album.mjs # takeover, intrinsic dimensions, full text, packed rows and status/recovery
```

The build writes `manifest.json`, `content.js`, and `background.js` to
`dist/extension/{fc2-live,sc-live,bunkr}/` at the repository root.
`apps/ios/scripts/deploy.py tango-live sync` builds and stages them into the
Tango app's `FC2Live`, `SCLive` and `Bunkr` extension targets. Each needs enabling once in Safari's
extension settings, with its site allowed.
