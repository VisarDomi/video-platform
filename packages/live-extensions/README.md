# Live download-list extensions

Two Safari web extensions hosted by the Tango app (`apps/ios`, provider `tango-live`) that
add or remove the open streamer from a PC download list: **FC2 live** (`live.fc2.com`,
`/api/fc2`) and **SC live** (`stripchat.com`, `/api/sc`). On a streamer's page each shows a
fixed top bar with a +/- toggle. The bar shows the website viewer's button: it imports
`DownloadListButton` and `buttons.css` from the `app` workspace (states and styles are
described in `packages/app/README.md`), inside a shadow root so the site's styles and the
button's stay apart. Tango's own +/- is in the app's native viewer
(`apps/ios/VideoApp/ViewerOverlay.swift`).

The server URL is `SERVER` in `src/core/config.ts` (`https://192.168.1.197:9999`).

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
npm run build -w live-extensions            # both extensions
npm run check -w live-extensions            # type check
```

The build writes `manifest.json`, `content.js`, and `background.js` to
`dist/extension/fc2-live/` and `dist/extension/sc-live/` at the repository root.
`apps/ios/scripts/deploy.py tango-live sync` builds both and stages them into the
Tango app's `FC2Live` and `SCLive` extension targets. Each needs enabling once in Safari's
extension settings, with its site allowed.
