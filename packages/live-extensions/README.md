# Safari extensions hosted by TsLive

Two Safari web extensions hosted by the TsLive app (`apps/ios`, provider `tslive-live`) that
add or remove the open streamer from a PC download list: **LADDER live** (`ladder-live.example`,
`/api/ladder`) and **FMP4 live** (`fmp4-live.example`, `/api/fmp4`). On a streamer's page each shows a
fixed top bar with a +/- toggle. The bar shows the website viewer's button: it imports
`DownloadListButton` and `buttons.css` from the `app` workspace (states and styles are
described in `packages/app/README.md`), inside a shadow root so the site's styles and the
button's stay apart. TsLive's own +/- is in the app's native viewer
(`apps/ios/VideoApp/ViewerOverlay.swift`).

The existing list server is `SERVER` in `src/core/config.ts`
(`https://192.168.1.197:9999`); FileHost uses `FILEHOST_SERVER` on port `9998`.

**FileHost to PC** handles video pages at `https://file-host.example/f/...`, `file-host.example/f/...`
and `file-host.example/f/...`. It probes the PC from its background page. With a recently
reachable PC, tapping the file's Download button queues the original video in
`~/Videos/plab/filehost/` and shows its progress on the button. Related-file links
and modified clicks keep their normal behavior. When the PC is unavailable,
the site's Download button works normally. A lost queue acknowledgement offers
an idempotent retry, so it cannot accidentally create a second download.

The independent `video-filehost-downloads.service` on HTTPS :9998 resolves FileHost's numeric metadata and expiring signature itself; Safari
can close after acceptance. `/api/filehost/health` advertises this capability;
`POST /api/filehost/downloads` accepts a file-page URL with the extension's
`X-Video-Download: 1` header; `GET /api/filehost/downloads/:id` reports progress.
Website origins cannot submit work. The server follows only the three FileHost
domains, their `dl` hosts and FileHost's `*.cdn.cr` hosts, with bounded metadata
responses. Only video filenames are accepted. The unit is enabled at boot and
systemd restarts it after an unexpected exit. This is an ordinary byte-copy
download, separate from capture and the conversion/description/upload campaign.

Jobs persist outside the checkout in
`~/.local/share/video-services/filehost-downloads/`. One transfer runs at a time.
Acceptance follows an fsynced atomic job write and directory flush. Partial
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

LADDER live starts watching at `document_start` and clicks the site's visible Login link
as soon as the parser inserts it, without waiting for DOMContentLoaded, images, or the
download-list bar. It also handles links added later. It follows LADDER's `/login/` link with
its return URL, in any site language; signing in on LADDER ID still uses Safari's normal login
page. It clicks once per
tab session, remembered in `sessionStorage` across reloads and return visits to prevent
redirect loops.

## Layout

- `src/core/downloadListBar.ts`: the one shared bar around the viewer's button; providers only classify routes
  (`src/provider/ladder-live.ts`: numeric ID; `fmp4-live.ts`: username, skipping
  non-streamer pages). The bar re-checks the route every second and hides on other pages.
- `src/extension/<name>.ts` is each content script; `background.ts` performs the
  PC requests (`https://192.168.1.197:9999/api/<ladder|fmp4>/member|add|remove`), only
  for its own provider, so page security policies never apply.

## Build

```bash
npm run build -w live-extensions            # all three extensions
npm run check -w live-extensions            # type check
node packages/live-extensions/test/filehost.mjs # mobile WebKit + background fixtures
```

The build writes `manifest.json`, `content.js`, and `background.js` to
`dist/extension/{ladder-live,fmp4-live,filehost}/` at the repository root.
`apps/ios/scripts/deploy.py tslive-live sync` builds and stages them into the
TsLive app's `LADDERLive`, `SCLive` and `FileHost` extension targets. Each needs enabling once in Safari's
extension settings, with its site allowed.
