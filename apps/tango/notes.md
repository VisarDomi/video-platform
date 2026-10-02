## what?
(extended description)

The list stays in the same order while browsing and returning to Home. Newly
discovered costreamers are appended to the end without duplicates. Refresh Home
or a stream page to fetch a new list. Blocked or unavailable streams are still
removed from navigation.
The viewer's **Multi: On / Off** button controls loading and playback of the
previous and next videos for both providers. It defaults to on. Off unloads
neighboring media and loads only the selected video; swipe navigation still
works. Changing the setting leaves the current video's position, pause and mute
state intact. The preference is saved in localStorage separately for each site,
survives browser restarts, and is synchronized when a cached viewer returns.


## Supported providers

```
tango.me
xvideos.com
```

## XVideos uploads

Open `https://www.xvideos.com/account/uploads` while signed in. The viewer reads
the first upload page immediately, then appends the remaining numbered pages
without replacing existing rows. Entries are deduplicated. You can open a video
before pagination finishes; the next-page cursor travels with the loaded list
and loading continues there. Hidden/cached pages cancel pending requests and
resume from the saved cursor when restored. Safari Back retains the list nodes
and reconciles entries loaded while viewing a video. Reload fetches a fresh list.
For this paginated provider, when Safari rebuilds the Back document, its history
entry restores the list's scroll position after the saved rows render. Tango
retains its existing native Back/bfcache behavior and does not use this fallback.
Later-page errors or unexpected redirects retain the loaded rows and cursor and
retry automatically after 1, 2, 4 seconds, up to 30 seconds between attempts.
Retries pause while hidden and stop when loading completes. There is no manual
pagination Retry button, and failed requests never mark a partial list complete.

Playback resolves each video's current signed media URLs on demand. When HLS is
available, it replaces the mobile `hls_low.m3u8` master with the full `hls.m3u8`
master, selects the variant with the largest resolution (then bitrate), and loads
that media playlist directly. This pins the highest available quality,
including 1080p or higher when the upload exposes it. It does not upscale a 720p
upload or automatically fall back to a lower HLS variant on failure. If the site
exposes only MP4 sources, the high source is preferred over the low source.
The current quality is shown alongside pause, mute and seeking. Use Safari’s
swipe-back navigation to return to the uploads list.
Unavailable uploads remain in the list; Retry refreshes the playback source.

On upload lists and video pages, the extension synchronously stops and rewrites
the document before any network request. Authentication and list loading happen
inside the viewer shell, so the native site UI is not left rendering while an
authentication request runs. An expired session redirects to the native `/account`
login page. Only that route waits for login, checking every three seconds and
opening Uploads automatically after success. OAuth popups and upload-management
pages stay native.
Like Manga Reader and Tango, the Safari build replaces the document's children
instead of opening/closing its parser; this preserves Safari's document lifecycle.
The userscript retains `document.open()`/`document.close()`.

XVideos authentication uses cookies, not sessionStorage. The Safari extension's
background helper makes a session-only `session_token_auth` cookie persistent with
the expiry of the site's existing `session_token`, retaining HttpOnly, Secure,
SameSite, domain and path, separately for each regular Safari cookie store.
Private stores are skipped. Cookie values never go into page storage or content
messages. Logout/removal is respected; no deleted cookie is restored from a
backup. Server expiry/revocation still requires login. This persistence is an
extension capability (`cookies` permission), not part of the plain userscript.
The helper rechecks after XVideos page/API responses (`webRequest` permission),
because [Safari does not support `cookies.onChanged`](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility); this also handles the
site replacing the auth cookie with a new session-only cookie during browsing.

Video Platform's saved Chromium profile/login flow was used for read-only live
verification, but its credentials and cookies are never bundled or copied into
Safari. Native permissions must include XVideos for the extension to run there.

### Provider contract and naming

Keep the `stream-viewer` repo/package and installed extension identity. Both
providers share list, routing, state, and the three-slot viewer. `Provider.playback`
distinguishes live playback from full videos, `resolvePlayback` supplies VOD
sources lazily, and optional capabilities expose co-streamers, follow, block and
download-list actions only where supported. The legacy `Stream` field names are
retained for existing Tango state; XVideos uses upload identity per entry.
There is no separate viewer or Video Platform service dependency.

## Safari extension

Stream Viewer is also an independent Safari Web Extension inside the shared
**Reader Extensions** iOS app. Gallery Reader, KM Explorer and Stream Viewer
remain separate extensions with separate permissions and bundles.

```sh
npx tsc --noEmit
npm run build:extension
npm run tests:extension
```

Build output is `dist/extension/{manifest.json,content.js}`. The shared iOS Xcode
host is in the separate [Reader Extensions](https://github.com/VisarDomi/reader-extensions)
repo (default checkout: `../../reader-extensions`). Run `npm run build` there to
build/stage all four bundles before building/installing the host.
The Stream Viewer extension ID is `com.visar.galleryreader.extensiontest.StreamViewer`.

For an individual update, run `npm run build -- stream-viewer` from the host repo,
or build locally here and use `npm run stage -- stream-viewer` there. Other staged
bundles stay unchanged. The shared
[fresh-machine/deployment guide](https://github.com/VisarDomi/reader-extensions#fresh-machine-setup)
documents private configuration, SSH, GUI-session signing and installation. Verify the staged
and embedded `Stream Viewer.appex/content.js` hashes against the local bundle.
A local web bundle build alone does not update the installed Safari extension;
the shared **Reader Extensions** app must be rebuilt and installed, then the
provider page refreshed. Coordinate this install so other extensions' pending
experiments are not deployed accidentally.

Enable Stream Viewer in Settings → Apps → Safari → Extensions and allow
`tango.me`/`www.tango.me` and `xvideos.com`/`www.xvideos.com`. Disable its Userscripts version while using the extension.
The Tango provider uses the same origin storage, cookies, session refresh,
download-list server, routes and gestures. No account data is migrated or cleared.
If a new login is needed, temporarily disable the extension to use Tango's login
page, then re-enable and refresh.

`src/main.ts` remains the userscript entry point. `extension/main.ts` validates
the provider, guards repeated document-start injection, and calls the same app
modules. Both providers use the extension's guarded DOM replacement after
`window.stop()`, before authentication. The shell creates its head/body and
viewport because injection can precede the site's markup. Injection is
MAIN-world, document-start, top-frame, and limited to the Tango and XVideos hosts.
XVideos takeover covers upload listings and video-page paths; native account
login redirects to Uploads once authenticated. The same bundle has a separate
background document/worker branch for cookie persistence; it never runs viewer
code there or blocks page startup. Its request observer does not alter responses.
This does not promise that no original-site bytes or scripts ever run.

Both builds use the same three-video scroll behavior: midpoint selection keeps
the playing element in place without programmatic scrolling during momentum.
On `scrollend`, with no added delay and no finger down, a blank-spacer landing
snaps to just the next/previous
entry in the scroll direction (or stays at the list boundary). There is no
distance-based jump through the stream list.

## [Testing](test.md)
The userscript-injection test harness and native extension checks are described
in [test.md](test.md). The live action suite changes account data; do not run it
as an ordinary extension smoke test.

## Manual maintenance

`scripts/tango-unblock-blocklist.mjs` is a standalone account-maintenance utility,
not part of either app or its tests. It reads the PC's existing Tango session and
defaults to a dry run; `--execute` unblocks **every** account on the blocklist.
Do not use it for routine validation or cleanup.
