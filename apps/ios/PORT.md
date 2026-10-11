# Provider apps

Five iPhone apps share one Swift host (`VideoApp/`). `providers.json` is the registry;
`scripts/project.py <provider>` generates that provider's project and Info.plist. The local
apps and Video Vault are native lists; Tango still shows tango.me with its content script
until its native rewrite (ios-tools `native/PLAN.md`, step 7).

| Provider | App | Bundle ID | Source |
| --- | --- | --- | --- |
| `tango` | Tango local | `com.visar.TangoLocal.paid` | the PC's recordings API (`https://192.168.1.197:9999`) |
| `fc2` | FC2 local | `com.visar.FC2Local.paid` | the PC's recordings API |
| `sc` | SC local | `com.visar.SCLocal.paid` | the PC's recordings API |
| `vault` | Video Vault | `com.visar.Ptrex.paid` | the XVideos and Porntrex uploads pages (`native`) |
| `tango-live` | Tango | `com.visar.Tango.paid` | `https://tango.me/` |

**Tango** runs the shared viewer's `tango-live` provider on tango.me (its notes are in
`apps/tango`, which has no app code) and hosts three Safari extensions: **Tango Login**
(`.Login`, the Safari login handoff), **FC2 live** (`.FC2Live`) and **SC live** (`.SCLive`),
the download-list bars from `packages/live-extensions`.

**Video Vault**'s bundle ID is `com.visar.Ptrex.paid`; a different ID would install a
separate app without its Porntrex session and data. It lists the pipeline's XVideos and
Porntrex uploads together, oldest recording first (`VideoApp/Vault.swift`, ported from
`vault` in `packages/app/PROVIDERS.md`): only uploads whose title carries the recording in
brackets, `[YYYY-MM-DD HHMMSS streamer]` (a split part adds ` | part N`); other uploads stay
on the sites but are not listed. The same recording on both sites shows `Xvid` or `Ptrex`.

## Behavior: native lists with a native player

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
  - A row opens the native viewer with the list; the list's later changes follow it, and
    the viewer asks the list for what only the provider can do (`ViewerHost.swift`: Video
    Vault's playback sources, Tango's co-streamers, follow, block, the login). Tango's list
    is still its web page (`routes/nativeViewer.ts`, `ViewerBridge.swift`).
  - Local HLS and Tango's playlists are known without asking (`mediaHint`), so playback
    never waits on a suspended page. Edits and the +/- download lists go to the PC directly
    (`ViewerPC.swift`).
  - Tango's playlists need its 10 s stream tokens, so they load through a resource loader
    that fetches them with fresh tokens (`ViewerMedia.swift`: `TangoTokens`, every 5 s while
    a stream plays, and the session when it is about to expire while the app is in the
    background; the web view's cookies get the result). Segments need no tokens and load
    directly.
  - Unmuted, the viewer takes the audio like Safari's video with sound and shows on the lock
    screen with play/pause, a scrubber (recordings) and next/previous (the neighbouring
    videos); muted, it mixes with other apps' audio. A call or Siri pauses it; it carries
    on afterwards. A failed or stalled recording recovers at its position; a live stream
    that ended gives way to the next one, as in the web viewer.
  - A killed app reopens its viewer (`viewer-checkpoint.json`, written off the main thread:
    every swipe saves it, and Tango's 4,000-recording list takes about 60 ms to encode);
    progress is `viewer-progress.json`, seeded once from the web viewer's localStorage.
- **Lists** (`VideoApp/VideoList.swift`) look like the website's: a 52-point row per video
  with its name (red while recording or live, orange when edited), duration (Video Vault: a
  site mark) and estimated size (bold above 350 MiB); the last viewed row is highlighted and,
  after the viewer closes, scrolled into view if needed. The list's place (top row and
  offset) is written whenever scrolling settles, so a kill returns to the same rows. Pull
  down to reload; an unreachable PC or site shows a message with Retry.
- **Local apps** (`VideoApp/LocalList.swift`) keep the PC's list on the phone
  (`list-cache.json`), so it shows at once, offline and after a kill, and follow the PC's
  change feed (`/api/videos/changes`, one long-polling request at a time while on screen):
  a new recording, a finished recording, an edit or a deletion arrives within a second,
  placed without moving the rows on screen. The phone trusts the PC's mkcert root. The
  first native launch read the web version's highlight and viewer positions from the
  website's localStorage once.
- **Video Vault** (`VideoApp/VaultList.swift`) opens with its last complete list
  (`vault-list.json`) and reads both sites again behind it (and on a pull, and on return
  after ten minutes), from the signed-in account's uploads pages, which are fetched and
  parsed, never executed, with Safari's user agent and the app's own cookie jar
  (`cookies.json`, KitNet). A signed-out site keeps its earlier rows under a notice.
  Playback sources are resolved when needed (XVideos' full-quality HLS master, Porntrex's
  highest MP4) and played with the site's Referer, the same user agent and the jar's
  cookies. The first native launch moved the web version's cookies out of WebKit (and its
  login-cookie backup) into the jar, once.
  - XVideos signs in with its own page in a sheet (the notice opens it; WebKit only here):
    once its uploads page answers with the sheet's cookies, they move into the jar.
    Session-only cookies (`session_token_auth`) are kept like persistent ones.
  - Porntrex keeps **one active session per account; the newest login wins**: a password
    login, or signing back in with the 30-day `kt_member` cookie, logs every other device
    out. Video Vault shares the pipeline's session instead: `npm run ptrex:connect-iphone`
    (phone unlocked and paired) copies the session into the app's data folder
    (`porntrex-session.json`, via `devicectl`) and relaunches it; the app replaces its
    Porntrex cookies (removing `kt_member`, pinning the rest for 400 days), checks them with
    a fresh request and leaves `porntrex-session-result.json`, which the command reads
    back. Do not log in on the phone: it stops the pipeline; run the command again instead.
  - The +/- button asks the PC's three download lists directly (`ViewerPC.swift`).
- **Tango** signs in with Google, which a web view cannot do, so it uses a Safari
  handoff: sign in on tango.me in Safari, Import with the Tango Login extension, delete
  Tango's Safari website data and confirm in the app ("Safari data cleared — continue").
  Tango Login (`Login/`) reads `Tango-RT`, `-DI`, `-DeviceId`, `-ST` and `-WST` for the
  gateway's refresh path from the active tab's own cookie store and saves them in the
  shared Keychain (service `TangoLogin`, account `session`, this device only).
  `VideoApp/TangoSession.swift` then moves the imported cookies from that inbox into the
  web view (emptying the inbox) and gives the page the account and session IDs from the
  token; the page refreshes the session every 30 minutes and the playback tokens every
  5 seconds while it runs, and the native viewer renews the tokens of the playlists it plays
  (and the session while the app is in the background, `ViewerMedia.swift`). SiteCookies
  keeps `Tango-RT`/`-DI`/`-DeviceId` durable. When Tango reports the session
  gone, the viewer navigates to `videoapp://login` and the app shows the handoff screen.
  FC2 live and SC live need enabling once in Safari's extension settings, with their sites
  allowed; their background pages call the PC's `/api/fc2|sc/member|add|remove`.
- Each app keeps its own data in `Library/Application Support/LocalVideos`. No icon or
  launch artwork; the background mode is audio (the native viewer); the only entitlement
  is Tango's Keychain group (`<team>.com.visar.Tango.paid`), shared with Tango Login.
- **Tango** (until step 7) is a full-screen tab on tango.me running its content script;
  its page stays on tango.me over HTTPS and identifies as Safari. A killed app reopens the
  page (WebKit `interactionState`). Its login cookies are kept durable by
  `VideoApp/SiteCookies.swift`.

## Build, deploy and inspect

Start with [shared Mac access](/home/visar/Documents/environment/mac-access.md).
`scripts/deploy.py` runs on this PC and drives the Mac over SSH (`visar@192.168.1.198`,
the runbook's known-hosts file; it falls back to the Mac's Wi-Fi automatically when
Ethernet is down, see `mac-connect --check`). Mac mirror:
`/Users/visar/Developer/video-platform/apps/ios`. The phone
(`00008101-000639912881401E`) is cabled to the Mac; paid team `65U58U86DD`. From this folder:

```sh
python3 scripts/deploy.py <provider> sync      # rsyncs sources to the Mac; Tango also builds and stages content.js and its web extensions
python3 scripts/deploy.py <provider> test      # policy and Video Vault tests on the Mac (scripts/test.sh)
python3 scripts/deploy.py <provider> build     # attached GUI session, signing lock
python3 scripts/deploy.py <provider> status
python3 scripts/deploy.py <provider> install   # verifies, installs over, approves for renewal, launches
```

`install` checks bundle ID, display name, start URL, site scope (Tango), the native list
key (Video Vault), bundled content script, extensions, icon absence, signature, paid
team, phone provisioning and an expiry more than 45 days away before replacing the same
app. Never uninstall to update (that would sign the online apps out). No LaunchAgent is
created. Simulator builds: `SIMULATOR=1 /usr/bin/python3 scripts/build-provider.py
<provider>` on the Mac; they include NativeKit's test hooks (ios-tools `native/scripts/sim`).

## Renewal

This repository renews its own apps with its Mac scheduler,
`com.visar.renewal.video-platform` ([ios-tools renewal](../../../../ios-tools/renewal/PAID-REFRESH.md)).
`scripts/renewal.py` lists the monthly entries (Mac mirror `/Users/visar/Developer/video-platform/apps/ios`):
`<provider>-local` (local apps) and `<provider>` (online apps). Their inputs are
`VideoApp`, `Shared`, `Kit`, `providers.json`, `scripts/project.py`, `scripts/build-provider.py`
and, for Tango, the staged `build/<provider>/content.js`; Tango also lists `Login`,
`Extension` and its staged web extensions. The Mac needs no Node. A new provider in
`providers.json` needs no change outside this repository; rerun `configure-refresh.py` for this mirror.
`install` approves the installed build as that app's renewal baseline, keeping its
renewal date, when neither its inputs nor the app changed since `build`; otherwise it
prints why approval was skipped. No scheduler pause is needed. See `verification.json`.
