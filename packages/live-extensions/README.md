# Live download-list extensions

Two Safari web extensions hosted by the TsLive app (`apps/ios`, provider `tslive-live`) that
add or remove the open streamer from a PC download list: **LADDER live** (`ladder-live.example`,
`/api/ladder`) and **FMP4 live** (`fmp4-live.example`, `/api/fmp4`). On a streamer's page each shows a
fixed top bar with a +/- toggle. The bar shows the website viewer's button: it imports
`DownloadListButton` and `buttons.css` from the `app` workspace (states and styles are
described in `packages/app/README.md`), inside a shadow root so the site's styles and the
button's stay apart. TsLive's own +/- is in the app's native viewer
(`apps/ios/VideoApp/ViewerOverlay.swift`).

The server URL is `SERVER` in `src/core/config.ts` (`https://192.168.1.197:9999`).

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
npm run build -w live-extensions            # both extensions
npm run check -w live-extensions            # type check
```

The build writes `manifest.json`, `content.js`, and `background.js` to
`dist/extension/ladder-live/` and `dist/extension/fmp4-live/` at the repository root.
`apps/ios/scripts/deploy.py tslive-live sync` builds both and stages them into the
TsLive app's `LADDERLive` and `SCLive` extension targets. Each needs enabling once in Safari's
extension settings, with its site allowed.
