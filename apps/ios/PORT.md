# Provider apps

Five iPhone apps share one Swift host (`VideoApp/`). `providers.json` is the registry;
`scripts/project.py <provider>` generates that provider's project and Info.plist. Every app
is a native list with the native viewer over it; no app shows a website.

| Provider | App | Bundle ID | Source |
| --- | --- | --- | --- |
| `tango` | Tango local | `com.visar.TangoLocal.paid` | the PC's recordings API (`https://192.168.1.197:9999`) |
| `fc2` | FC2 local | `com.visar.FC2Local.paid` | the PC's recordings API |
| `sc` | SC local | `com.visar.SCLocal.paid` | the PC's recordings API |
| `vault` | Video Vault | `com.visar.Ptrex.paid` | the XVideos and Porntrex uploads pages (`native`) |
| `tango-live` | Tango | `com.visar.Tango.paid` | Tango's gateway API (`native`) |

**Tango** lists live streams natively (`VideoApp/Tango.swift`, `TangoList.swift`; its notes
are in `apps/tango`, which has no app code) and hosts three Safari extensions: **Tango Login**
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
    list again. The left edge otherwise slides the viewer away to the list, and the list's
    right edge brings the last viewed video back (as Safari's forward), at its saved time;
    a video no longer listed (a deleted recording, a removed upload, a stream that ended) has
    no forward. Opened that way, a stream found ended, or a video the list drops while it is
    still the one shown, slides back to the list instead of moving on to the next.
  - A row opens the native viewer with the list; the list's later changes follow it, and
    the viewer asks the list for what only the provider can do (`ViewerHost.swift`: Video
    Vault's playback sources, Tango's co-streamers, follow, block, the login).
  - Local HLS and Tango's playlists are known without asking (`mediaHint`), so playback
    never waits on a suspended page. Edits and the +/- download lists go to the PC directly
    (`ViewerPC.swift`).
  - Tango's playlists need its 10 s stream tokens, so they load through a resource loader
    that fetches them with fresh tokens (`TangoSession` in `Tango.swift`: every 5 s while a
    stream plays). Segments need no tokens and load directly.
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
  down to reload; an unreachable PC or site shows a message with Retry. A new list keeps the
  rows on screen in place, which sets the offset and would stop a fling dead, so one that
  arrives while a finger or momentum moves the rows waits until they stop, and one whose rows
  look the same is not reloaded at all (Video Vault publishes each site page as it is read;
  October 12, 2026: its scrolling stopped abruptly during every refresh).
- **Relaunch** (October 13, 2026): the first frame is the screen as it was left. Lists read
  their kept rows before it (they already did); Tango's sign-in screen, when it was showing,
  comes back in the first frame (with the PC button as last seen) and stays until the session
  has worked, instead of disappearing for a second while a rejected token is tried. A viewer
  restored from its checkpoint shows the picture it had (viewer-poster.jpg, saved when the app
  leaves the screen, at the video's place) with the controls as they were and the saved time,
  until the player draws its own picture; sound starts muted, as always. NativeKit's
  `scripts/restore-check` measures the lists; the poster needs the phone (the simulator here
  cannot play video without overloading the Mac).
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
- **Tango** (`VideoApp/TangoList.swift`) opens with its last list (`tango-list.json`) and
  asks Tango's gateway for a new one behind it: followed streams first, then
  recommendations, one per streamer, never blocked ones; the order then stays while
  browsing (pull down, or return after half an hour, for a new list). Co-streamers found
  while watching join the end; ended and blocked streams leave. Follow, the two-step Block
  and co-streamers go to the gateway. The session lives in the app's cookie jar and
  `TangoSession` (`Tango.swift`) is its only owner: the session token is refreshed from the
  refresh token when it has under five minutes left (one refresh at a time; a rotated
  refresh token is saved before anything else, as `packages/auth` does), and the stream
  tokens every 5 seconds while a stream plays. The first native launch took the newest
  session out of WebKit's cookies (and the login-cookie backup), once.
  - Signing in stays the Safari handoff, so Tango works away from home: sign in with Google
    on tango.me in Safari, Import with the Tango Login extension, delete Tango's Safari
    website data and confirm in the app ("Safari data cleared — continue"). Tango Login
    (`Login/`) reads `Tango-RT`, `-DI`, `-DeviceId`, `-ST` and `-WST` for the gateway's
    refresh path from the active tab's own cookie store and saves them in the shared
    Keychain (service `TangoLogin`, account `session`, this device only); the app moves a
    confirmed import into its jar and empties the inbox. (Google refuses sign-in inside an
    app's web view, and no Apple API gives an app the cookies a site sets in Safari.)
  - On the home network the login screen also offers **Log in from the PC**: the PC
    (`POST /api/tango/phone-session`, packages/server, with the key built into the app from
    `Private/tango-phone-key`) signs in with a fresh browser profile
    (`packages/auth` `phoneSession.ts`), returns that new session and drops the profile, so
    each device holds its own refresh token; the PC's own session is never copied.
  - FC2 live and SC live need enabling once in Safari's extension settings, with their sites
    allowed; their background pages call the PC's `/api/fc2|sc/member|add|remove`.
- Each app keeps its own data in `Library/Application Support/LocalVideos`. No icon or
  launch artwork; the background mode is audio (the native viewer); the only entitlement
  is Tango's Keychain group (`<team>.com.visar.Tango.paid`), shared with Tango Login.

## Build, deploy and inspect

Start with [shared Mac access](/home/visar/Documents/environment/mac-access.md).
`scripts/deploy.py` runs on this PC and drives the Mac over SSH (`visar@192.168.1.198`,
the runbook's known-hosts file; it falls back to the Mac's Wi-Fi automatically when
Ethernet is down, see `mac-connect --check`). Mac mirror:
`/Users/visar/Developer/video-platform/apps/ios`. The phone
(`00008101-000639912881401E`) is cabled to the Mac; paid team `65U58U86DD`. From this folder:

```sh
python3 scripts/deploy.py <provider> sync      # rsyncs sources to the Mac; Tango also builds its web extensions and stages its PC login key
python3 scripts/deploy.py <provider> test      # policy and Video Vault tests on the Mac (scripts/test.sh)
python3 scripts/deploy.py <provider> build     # attached GUI session, signing lock
python3 scripts/deploy.py <provider> status
python3 scripts/deploy.py <provider> install   # verifies, installs over, approves for renewal, launches
```

`install` checks bundle ID, display name, start URL, the native list key, Tango's PC login
key, extensions, icon absence, signature, paid
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
and, for Tango, `Login`, `Extension`, its staged web extensions and `Private` (its PC login
key). The Mac needs no Node. A new provider in
`providers.json` needs no change outside this repository; rerun `configure-refresh.py` for this mirror.
`install` approves the installed build as that app's renewal baseline, keeping its
renewal date, when neither its inputs nor the app changed since `build`; otherwise it
prints why approval was skipped. No scheduler pause is needed. See `verification.json`.
