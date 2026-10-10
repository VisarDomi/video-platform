# Provider apps

Five iPhone apps share one Swift host (`VideoApp/`), following Gallery Reader's
provider apps. `providers.json` is the registry; `scripts/project.py <provider>`
generates that provider's project and Info.plist.

| Provider | App | Bundle ID | Start URL |
| --- | --- | --- | --- |
| `tango` | Tango local | `com.visar.TangoLocal.paid` | `https://192.168.1.197:9999/videos/tango` |
| `fc2` | FC2 local | `com.visar.FC2Local.paid` | `https://192.168.1.197:9999/videos/fc2` |
| `sc` | SC local | `com.visar.SCLocal.paid` | `https://192.168.1.197:9999/videos/sc` |
| `vault` | Video Vault | `com.visar.Ptrex.paid` | `https://www.porntrex.com/video-vault/` |
| `tango-live` | Tango | `com.visar.Tango.paid` | `https://tango.me/` |

**Tango** runs the shared viewer's `tango-live` provider on tango.me (its notes are in
`apps/tango`, which has no app code) and hosts three Safari extensions: **Tango Login**
(`.Login`, the Safari login handoff), **FC2 live** (`.FC2Live`) and **SC live** (`.SCLive`),
the download-list bars from `packages/live-extensions`.

**Video Vault**'s bundle ID is `com.visar.Ptrex.paid`; a different ID would install a
separate app without its Porntrex session and data. It lists the pipeline's XVideos and
Porntrex uploads together, oldest recording first (`vault` in `packages/app/PROVIDERS.md`):
only uploads whose title carries the recording in brackets, `[YYYY-MM-DD HHMMSS streamer]`
(a split part adds ` | part N`); other uploads stay on the sites but are not listed
(`isPipelineUpload` in `packages/app/src/providers/uploadSite.ts`). It runs on porntrex.com:
XVideos' security policy blocks Porntrex media on xvideos.com, while Porntrex sends none.
XVideos pages come through `VideoApp/SiteWorker.swift` (`workers` in `providers.json`): a hidden web view on
`https://www.xvideos.com/robots.txt` that shares the app's cookie store, so its requests are
first-party, like a second Safari tab. The vault page asks it with
`webkit.messageHandlers.vaultSite`; only the vault page (porntrex.com, main frame) may ask,
and only for paths on XVideos (`AppPolicy.workerURL`). The page itself may open XVideos only
to log in. Its login cookies cover both sites.

## Behavior: a full-screen Safari tab with a native player

- **Videos play in a native viewer** (`VideoApp/Viewer*.swift`), over the list page,
  because WebKit pauses a page's video whenever the phone locks or the app leaves the
  screen. Videos play on through lock and the background until they end (background
  audio), and nothing pauses, reloads or jumps on the way back.
  - It is the web viewer (`packages/app` `routes/videoViewer.ts`) with AVPlayer: the same
    three-scope feed (vertical swipes through the list, neighbours touching during a swipe,
    a runway landing moving one video), the upper-half horizontal seek, the lower-half swipe
    that shows or hides the controls, the overlay with its buttons (mute, follow, block, +/-,
    save/cut/return, markers), all three videos muted until unmuted, progress every 3 s.
  - A pinch zooms the current video anywhere on screen. Zoomed, the list stays put and the
    left edge is not Back: drags pan the picture as in Safari, except the upper half's
    horizontal seek (which then starts anywhere). Zoomed back out, swipes move through the
    list again. The left edge otherwise slides the viewer away to the list.
  - The list page stays a web page. A row opens the native viewer with the list
    (`routes/nativeViewer.ts`, `ViewerBridge.swift`); the list's later changes follow it,
    and the viewer asks the page for what only the provider can do (Video Vault's playback
    sources, Tango's co-streamers, follow, block, the login page). A viewer address the page
    is opened at (an old restore point) opens the list with that video in the native viewer.
  - Local HLS and Tango's playlists are known without the page (`mediaHint`), so playback
    never waits on a suspended page. Edits and the +/- download lists go to the PC directly
    (`ViewerPC.swift`).
  - Tango's playlists need its 10 s stream tokens, so they load through a resource loader
    that fetches them with fresh tokens (`ViewerMedia.swift`: `TangoTokens`, every 5 s while
    a stream plays, and the session when it is about to expire while the app is in the
    background; the web view's cookies get the result). Segments need no tokens and load
    directly. Video Vault's media gets the page's Referer, user agent and site cookies.
  - Unmuted, the viewer takes the audio like Safari's video with sound and shows on the lock
    screen with play/pause, a scrubber (recordings) and next/previous (the neighbouring
    videos); muted, it mixes with other apps' audio. A call or Siri pauses it; it carries
    on afterwards. A failed or stalled recording recovers at its position; a live stream
    that ended gives way to the next one, as in the web viewer.
  - A killed app reopens its viewer (`viewer-checkpoint.json`); progress is
    `viewer-progress.json`, seeded once from the web viewer's localStorage.
- **Local apps** load the PC's page, API, +/- list buttons and HLS exactly as in
  Safari. No website code is bundled; deploying the website updates their list (the
  player is in the app). The phone already trusts the PC's mkcert root. Navigation is limited to the start URL and
  its subpaths (`VideoApp/Policy.swift`).
- **Online apps** load the provider's own site and run its content script
  (`packages/app/scripts/build-content.mjs <provider>`) at document start in the page
  world: the same Video Platform list/player as the website.
  Their page stays on the site's hosts over HTTPS; other sites (including ads) are
  blocked, and embedded frames (such as a captcha) are allowed. They identify as Safari.
  XVideos login uses the site's own password form inside the app (Porntrex and Tango
  sign in as below); the app stores no passwords. Logins are durable
  (`VideoApp/SiteCookies.swift`):
  - WebKit writes cookies to disk only when the app is suspended, so a login
    followed by a kill without a background transition (a swipe from the app
    switcher) would be lost. The app keeps its own copy of the login cookies
    (`keepCookies`, plus the durable cookie) in its container, beside WebKit's
    cookie file, and restores missing ones before the first page loads. When the
    site removes them (logout, revocation, expiry) the copy is cleared too.
  - XVideos keeps its login in a session-only, version-1 `session_token_auth`
    cookie. The app gives it `session_token`'s lifetime (about three months,
    sliding), stored as a version-0 cookie because
    Foundation ignores Expires on version-1 cookies. XVideos re-sends the
    session-only cookie on responses, so this re-runs every 3 seconds while open
    and at resign/background. With "remember me" ticked XVideos itself sets a
    30-day sliding login cookie.
  - Porntrex keeps **one active session per account; the newest login wins**. A password
    login, or signing back in with the 30-day `kt_member` cookie, logs every other device
    out. Video Vault therefore shares the pipeline's session instead of logging in:
    `npm run ptrex:connect-iphone` (phone unlocked, cabled to the Mac) copies the
    pipeline's Porntrex session (`PHPSESSID`) into Video Vault, pinned for 400 days, and
    removes `kt_member`. It keeps `PHPSESSID` among its login cookies so a kill does not
    lose it. Do not log in on the phone: it stops the pipeline; run the command again
    instead. The vault's page is Porntrex's 404 page, which loads whether or not Porntrex
    is signed in; signed out, the list keeps its Porntrex rows and says to run the command.
- **Tango** signs in with Google, which a web view cannot do, so it uses a Safari
  handoff: sign in on tango.me in Safari, Import with the Tango Login extension, delete
  Tango's Safari website data and confirm in the app ("Safari data cleared — continue").
  Tango Login (`Login/`) reads `Tango-RT`, `-DI`, `-DeviceId`, `-ST` and `-WST` for the
  gateway's refresh path from the active tab's own cookie store and saves them in the
  shared Keychain (service `TangoLogin`, account `session`, this device only).
  `VideoApp/TangoSession.swift` then moves the imported cookies from that inbox into the
  web view (emptying the inbox) and gives the page the account and session IDs from the
  token; the page refreshes the session every 30 minutes and the playback tokens every
  5 seconds itself, so the app has no native token refresh or media relay. SiteCookies
  keeps `Tango-RT`/`-DI`/`-DeviceId` durable. When Tango reports the session
  gone, the viewer navigates to `videoapp://login` and the app shows the handoff screen.
  FC2 live and SC live need enabling once in Safari's extension settings, with their sites
  allowed; their background pages call the PC's `/api/fc2|sc/member|add|remove`.
- **Video Vault** (`downloadList` in `providers.json`) edits the PC download lists for
  the viewer's +/- button (`VideoApp/DownloadList.swift`), as the FC2/SC live extensions'
  background pages do, so no site's security policy applies to the PC requests. Only the
  site's main frame may ask, only `/api/tango|fc2|sc/member|exists|add|remove`. It asks once for
  local network access.
- Like a restored Safari tab, a killed app reopens the page you were on with its
  Back/Forward list (WebKit `interactionState`); only an app page becomes the restore
  point, and a blank restore falls back to the start page. In the list: edge-swipe Back/Forward, pinch zoom,
  inline playback, portrait/landscape and pull-down reload. An unreachable PC or site
  shows a message with Retry instead of Safari's error page.
- Each app has its own WebKit storage: progress, highlights and cookies are not
  shared with Safari. No icon, launch artwork or background refresh; the background mode is
  audio (the native viewer); the only
  entitlement is Tango's Keychain group (`<team>.com.visar.Tango.paid`), shared with
  Tango Login.

## Build, deploy and inspect

Start with [shared Mac access](/home/visar/Documents/environment/mac-access.md).
`scripts/deploy.py` runs on this PC and drives the Mac over SSH (`visar@192.168.1.198`,
the runbook's known-hosts file; it falls back to the Mac's Wi-Fi automatically when
Ethernet is down, see `mac-connect --check`). Mac mirror:
`/Users/visar/Developer/video-platform/apps/ios`. The phone
(`00008101-000639912881401E`) is cabled to the Mac; paid team `65U58U86DD`. From this folder:

```sh
python3 scripts/deploy.py <provider> sync      # rsyncs sources to the Mac; online apps also build and stage content.js (Tango: its web extensions)
python3 scripts/deploy.py <provider> test      # policy tests on the Mac
python3 scripts/deploy.py <provider> build     # attached GUI session, signing lock
python3 scripts/deploy.py <provider> status
python3 scripts/deploy.py <provider> install   # verifies, installs over, approves for renewal, launches
```

`install` checks bundle ID, display name, start URL, site scope, bundled content
script, extensions, icon absence, signature, paid team, phone provisioning and an
expiry more than 45 days away before replacing the same app. Never uninstall to update
(that would sign the online apps out). No LaunchAgent is created. Physical checks use
ios-tools' inspector on the Mac (`~/Developer/ios-tools/inspector`, see its README) with
`--bundle <bundle ID> --snapshot-file scripts/inspector-snapshot.js` while the app is in
the foreground.

## Renewal

This repository renews its own apps with its Mac scheduler,
`com.visar.renewal.video-platform` ([ios-tools renewal](../../../../ios-tools/renewal/PAID-REFRESH.md)).
`scripts/renewal.py` lists the monthly entries (Mac mirror `/Users/visar/Developer/video-platform/apps/ios`):
`<provider>-local` (local apps) and `<provider>` (online apps). Their inputs are
`VideoApp`, `Shared`, `providers.json`, `scripts/project.py`, `scripts/build-provider.py`
and, for online apps, the staged `build/<provider>/content.js`; Tango also lists `Login`,
`Extension` and its staged web extensions. The Mac needs no Node. A new provider in
`providers.json` needs no change outside this repository; rerun `configure-refresh.py` for this mirror.
`install` approves the installed build as that app's renewal baseline, keeping its
renewal date, when neither its inputs nor the app changed since `build`; otherwise it
prints why approval was skipped. No scheduler pause is needed. See `verification.json`.
