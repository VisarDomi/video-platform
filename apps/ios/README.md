# iPhone apps

ViewerVideo owns the provider payload and exposes named metadata and mutation operations;
controllers/decoders do not read or edit its JSON dictionary. VideoListController owns both
resign and background checkpoint phases, including cached-list dependencies. Provider lists
only pause/resume their own work and cannot select partial checkpoint behavior. Bunkr's
separate build-selected decoder and performance implementations remain isolated.


Six iPhone apps share one Swift host (`VideoApp/`). `providers.json` is the registry;
`scripts/project.py <provider>` generates that provider's project and Info.plist. Every app
is a native list with the native viewer over it; no app shows a website. Code shared with the
other iPhone apps is NativeKit (`Kit/`, vendored); its canonical copy and the shared rules are
in the [NativeKit guide](../../../../ios-tools/native/README.md).

| Provider | App | Bundle ID | Source |
| --- | --- | --- | --- |
| `tango` | Tango local | `com.visar.TangoLocal.paid` | the PC's recordings API (`https://192.168.1.197:9999`) |
| `fc2` | FC2 local | `com.visar.FC2Local.paid` | the PC's recordings API |
| `sc` | SC local | `com.visar.SCLocal.paid` | the PC's recordings API |
| `bunkr` | Bunkr local | `com.visar.BunkrLocal.paid` | completed original videos in `~/Videos/plab/bunkr/`, HTTPS :9998 |
| `vault` | Video Vault | `com.visar.Ptrex.paid` | the Porntrex uploads pages (`native`) |
| `tango-live` | Tango | `com.visar.Tango.paid` | Tango's gateway API (`native`) |

**Tango** lists live streams natively (`VideoApp/Tango.swift`, `TangoList.swift`) and hosts
four Safari extensions: **Tango Login** (`.Login`, the Safari login handoff), **FC2 live**
(`.FC2Live`) and **SC live** (`.SCLive`, the download-list bars), and **Bunkr to PC**
(`.Bunkr`, the webpage Download-button handoff). The last three come from `packages/live-extensions`.

**Video Vault**'s bundle ID is `com.visar.Ptrex.paid`; a different ID would install a
separate app without its Porntrex session and data. It lists the pipeline's Porntrex uploads, oldest recording first (`VideoApp/Vault.swift`): only uploads
whose title carries the recording in brackets, `[YYYY-MM-DD HHMMSS streamer]` (a split part
adds ` | part N`); other uploads stay on the sites but are not listed. Cached rows for a retired provider are excluded from the list.

**Bunkr local** uses the same native library/viewer experience with the PC's flat
original files. It has cached lists and saved playback positions, automatic list updates,
seeking, gestures, lock-screen/background audio and viewer restoration. The files
stream directly from `video-bunkr-downloads.service` on HTTPS :9998 using byte
ranges; no HLS conversion, streamer membership or recording-edit actions are
involved. The queue and library share one accepted-container contract: MP4, M4V,
MOV, MKV, WebM, AVI and TS. Rows show actual size and probed duration. `.part`, retained
fragments, hidden files and symbolic links are excluded. Publishing a completed
download or deleting a file on the PC updates the app through the same revision
feed contract as the other local apps. No files are moved or deleted by the app.
`VideoApp/LocalLibrary.swift` owns the shared Foundation-only API/cache models; the
provider's `LocalMediaKind` selects HLS recordings or original files (`file`);
the legacy `mp4` descriptor remains readable. Bunkr alone uses the indexed
filename-to-file-ID migration in its provider override.
Existing playback lookups use the
last published index and verify the file identity, without waiting for unrelated
new-file metadata probes.
Every VOD app plays only its current video. In Bunkr local only that video holds a
player: a paused neighbour shows a still of the keyframe its saved position opens on,
read once from the original file and kept on the phone, and the video last watched
keeps its paused player for a quick return. A saved position opens on its keyframe, a
seek shows a keyframe on the finger's side of where the gesture began, a drag holds
playback and shows a still per seek, and stopping or opening a video waits until the
document rests. The active file prefers a two-second buffer and starts as soon as
buffered data permits. Buffer recovery respects manual pause, seeks and
the end of a movie. Original video resolution and bytes are unchanged. Bounded
`bunkrPlayback` debug samples record activation delay, buffer state, transferred
bytes, dropped frames and the last seek without URLs or credentials. The design, its
virtual-iPhone measurements and its limits are in [Bunkr/README.md](Bunkr/README.md).
Original AV1/VP9/VP8 files and MKV/WebM/AVI/TS containers use alternate native decoding behind the same
`ViewerUnit`; supported files keep AVFoundation. VP9 first tries the direct
FFmpeg/VideoToolbox backend when a real hardware session opens. AV1 uses the
same direct sample-buffer renderer with dav1d when hardware decoding is absent;
other fallback formats and failed preparation retain VLCKit. The direct backend and its
validation runbook are documented in [ThirdParty/AetherCore](ThirdParty/AetherCore/README.md).
No file is converted, replaced
or proxied into another format. The alternate engine retains the shared controls,
fitted surface, zoom, current-only visibility and saved timeline.
Its library/media setup runs off the main thread. Backgrounding disables its video
track while retaining audio/time, and foregrounding restores that track.
The checksum-pinned official iOS binary, system TLS trust and renewal inputs are
documented in [ThirdParty/VLCKit](ThirdParty/VLCKit/README.md).
The fallback uses the bundled FFmpeg container parser to avoid the pinned native
MP4 parser's paused AV1 seek resets. Restoration seeks on the full input without
changing its time origin. Native seek completions preserve pause/volume intent;
EOF stays terminal through resume/return, and seeking afterwards reopens at the
requested time's keyframe. The real player passed the original-file A14 seek, return,
saved-position, EOF and explicit-replay checks on November 1; the phone check's
expectations (`scripts/check-original-video.py`) follow the keyframe landings but have
not been run on the phone since.
The ✏️ button beside mute renames the original file on the PC and updates its list/player
name. A stable file identity keeps the current player, saved position and row
identity intact across renames. New names keep the source container's extension and cannot
overwrite another file. A lost reply is checked with a read before reporting
failure. The download receipt follows the new name and retains its original
name. File renames are journaled for recovery after power loss; old playback
addresses remain pinned to the same file.
OK, Cut and Return Original replace a recording variant atomically: its layout key,
reserved geometry, player and checkpoint refer to the same slot. A list response
that arrives before the action acknowledgement uses the same variant transition;
a delayed result targets its original recording instead of whichever video is
currently selected. The local cache incorporates the acknowledged result and
rejects older in-flight list responses.
The native decoder retires its stopped input asynchronously, so returning to the
list does not synchronously wait for libvlc destruction. Its original drawing
surface stays alive until the native stop event.

Viewport restoration samples the current list and viewer on resigning active, even
before a scroll settles, and drains list metadata plus position writers. The checkpoint
stores fitted-document offset, zoom/pan and control visibility. Its explicit open/closed
state lets Forward restore the last viewport while a relaunch after closing still opens
the list. Closed checkpoints retain only the selected video's metadata. Existing playback
save cadence is unchanged; restoration does not add a faster timer.

## Rules

- Never uninstall an app to update it: `install` replaces it in place. Uninstalling signs
  the online apps out and loses their data. Never change a bundle ID, for the same reason.
- Do not log in to Porntrex on the phone: it stops the pipeline. Run
  `npm run ptrex:connect-iphone` instead (Video Vault below).
- Never copy a Tango refresh token between devices: the PC and the phone each hold their own
  (`packages/auth/SESSION-RECOVERY.md`).
- Never commit `Private/` (Tango's PC login key) or `build/`; both are gitignored.
- On the shared old Intel Mac, simulator playback checks use one actively decoded
  stream at a time, with neighbours paused and no parallel video test or guest.
  Run through `mac-workload`; measure new codecs/resolutions before choosing the
  physical phone. A single 720p H.264 stream was verified on November 2.
- Routine UI, lifecycle and simulated-network checks use the Mac's virtual iPhone. Use the
  physical phone only for behavior that cannot be established there, such as its actual
  network/authentication path. Remove any temporary phone controller and verify removal.
- The main thread only shows (below). Keep new work off it and check frames with
  FrameMonitor.
- A changed renewal input (Renewal, below) blocks that app's monthly renewal until it is
  deployed again. The inputs are shared, so once a change to `VideoApp`, `Shared`, `Kit` or
  `providers.json` is synced to the Mac, every app needs a deploy. Do not touch them, not
  even comments, without deploying.

## Behavior: native lists with a native player

- **Videos play in a native viewer** (`VideoApp/Viewer*.swift`), over the list,
  because WebKit pauses a page's video whenever the phone locks or the app leaves the
  screen. Videos play on through lock and the background until they end (background
  audio), and nothing pauses, reloads or jumps on the way back.
  - At minimum zoom, every video uses the largest aspect-preserving size that fits both
    viewport dimensions. Tall portraits fit the height; wide videos fit the width, with
    black space where needed. Scrolling can leave any part of a picture on screen; lifting a finger never moves it.
  - It works like the website's viewer (`packages/app` `routes/videoViewer.ts`) with
    AVPlayer: a continuous document of fitted videos (vertical scrolling through the list,
    neighbours appearing and touching only during scrolling, with no blank runways or snap positions), the upper-half horizontal
    seek, the lower-half swipe that shows or hides the controls, the overlay with its buttons
    (mute, follow, block, +/-, save/cut/return, markers), videos muted until unmuted, progress every 3 s. Save/cut/return and markers show only for local recordings.
  - A pinch zooms the current video anywhere on screen. Zoomed, the list stays put and the
    left edge is not Back: drags pan the picture as in Safari, except the upper half's
    horizontal seek (which then starts anywhere). Zoomed back out, swipes move through the
    list again. The left edge otherwise slides the viewer away to the list, and the list's
    right edge brings the last viewed video back (as Safari's forward), at its saved time;
    a video no longer listed (a deleted recording, a removed upload, a stream that ended) has
    no forward. Opened that way, a stream found ended, or a video the list drops while it is
    still the one shown, slides back to the list instead of moving on to the next.
    Pinching scales one permanent viewport containing the original player layers and any
    restoration poster. No second player layer is attached at pinch start or removed at
    pinch end. The controls remain outside that zoomed document.
  - A row opens the native viewer with the list; the list's later changes follow it, and
    the viewer asks the list for what only the provider can do (`ViewerHost.swift`: Video
    Vault's playback sources, Tango's co-streamers, follow, block, the login).
  - Local HLS and Tango's playlists come with the video (`ViewerVideo.media`), so playback
    never waits on the list; a video without one (Video Vault's) is resolved through
    `ViewerHost.resolve`. Edits and the +/- download lists go to the PC directly
    (`ViewerPC.swift`).
  - Tango's playlists need its 10 s stream tokens, so they load through a resource loader
    that fetches them with fresh tokens (`TangoSession` in `Tango.swift`: every 5 s while a
    stream plays). Segments need no tokens and load directly.
  - Unmuted, the viewer takes the audio like Safari's video with sound and shows on the lock
    screen with play/pause, a scrubber (recordings) and next/previous (the neighbouring
    videos); muted, it mixes with other apps' audio. A call or Siri pauses it; it carries
    on afterwards. A failed or stalled recording recovers at its position; a live stream
    that ended gives way to the next one, as in the web viewer. A live stream that plays
    without a picture for 3 s counts as ended (`ViewerUnit.swift`).
  - A killed app reopens its viewer (`viewer-checkpoint.json`, written off the main thread:
    every scroll position saves it, including the active picture's exact top, and Tango's 4,000-recording list takes about 60 ms to encode);
    progress is `viewer-progress.json`.
- **Lists** (`VideoApp/VideoList.swift`) look like the website's: a 52-point row per video
  with its name (red while recording or live, orange when edited), duration (Video Vault: a
  site mark) and estimated size (bold above 350 MiB); the last viewed row is highlighted and,
  after the viewer closes, scrolled into view if needed. The list's place (top row and
  offset) is written whenever scrolling settles, so a kill returns to the same rows. Pull
  down to reload; an unreachable PC or site shows a message with Retry. A new list keeps the
  rows on screen in place, which sets the offset and would stop a fling dead, so one that
  arrives while a finger or momentum moves the rows waits until they stop, and one whose rows
  look the same is not reloaded at all (Video Vault publishes each site page as it is read;
  without this its scrolling stopped abruptly during every refresh).
- **The main thread only shows**: a local app applies the PC's changes and describes the
  rows in the background (a live recording changes Tango's 4,000-row list every few
  seconds), Video Vault merges, orders and describes each site page in the background, and
  rows are compared by what they show (`ViewerVideo.Look`). A new list also waits while the
  open viewer is being swiped. Writes go to background queues without waiting (progress,
  checkpoint, the poster's JPEG), except when the app leaves for the background, which waits
  for them.
  - The audio session is activated and deactivated on its own queue, in order
    (`ViewerSession.swift`): Apple documents both as blocking calls, and deactivating it on
    the main thread made a fling right after closing the viewer stick for a moment. The lock
    screen's commands are registered at the first unmute (a muted viewer mixes with other
    audio and cannot own the lock screen).
  - The next viewer is built ahead (`VideoList.swift` `prepareSpare`): its overlay, three
    players and gestures take about 20 ms, so the list builds one 1.5 s after it loads and
    after each opening, only while nothing moves and no finger is down; a tap fills it and
    starts it (`ViewerController.open`).
  - A swipe's highlight changes the font and colour of the rows on screen in place (no
    reload, the list being under the viewer); a closing viewer, already off screen, does not
    lay itself out as its players stop.
  - NativeKit's FrameMonitor measures it on the phone (Instruments cannot record it): while
    the list or the viewer's feed moves, and for a second after the viewer closes, every
    frame over 25 ms is kept with the spans of our code that ran in it (`list.*`,
    `viewer.*`, `open.*`, `activate.*`, `close.*`, `unit.attach`), in `debug-state.json`
    ("frames"), written when the app leaves the screen. Measured on the phone: opening the
    viewer 8-9 ms, a swipe's switch to the next video 1-2 ms, closing it 2-5 ms; in Tango
    local, 469 frames with none over 25 ms.
- **Relaunch**: the first frame is the screen as it was left. Lists read their kept rows
  before it. Tango's sign-in screen, when it was showing, comes back in the first frame (with
  the PC button as last seen) and stays until the session has worked, instead of
  disappearing for a second while a rejected token is tried. A viewer restored from its
  checkpoint shows the picture it had (`viewer-poster.jpg`, saved when the app leaves the
  screen, at the video's place) with the controls as they were and the saved time, until the
  player draws its own picture; sound starts muted, as always. NativeKit's
  `scripts/restore-check` measures the lists; the poster needs the phone (see the
  simulator rule).
- **Local apps** (`VideoApp/LocalList.swift`) keep the PC's list on the phone
  (`list-cache.json`), so it shows at once, offline and after a kill, and follow the PC's
  change feed (`/api/videos/changes`, one long-polling request at a time while on screen):
  a new recording, a finished recording, an edit or a deletion arrives within a second,
  placed without moving the rows on screen. The phone trusts the PC's mkcert root.
- **Video Vault** (`VideoApp/VaultList.swift`) opens with its last complete list
  (`vault-list.json`) and reads Porntrex again behind it (and on a pull, and on return
  after ten minutes), from the signed-in account's uploads pages, which are fetched and
  parsed, never executed, with Safari's user agent and the app's own cookie jar
  (`cookies.json`, KitNet). A signed-out site keeps its earlier rows under a notice.
  HTTP errors (including 401/403), throttling and unexpected challenge redirects are
  retried as availability failures, not reported as a sign-out. Only an explicit
  protected-page redirect to home/login or its login form establishes that the session ended.
  Playback sources are resolved when needed (Porntrex's highest MP4) and played with the site's Referer, the same user agent and the jar's
  cookies.
  - Porntrex keeps **one active session per account; the newest login wins**: a password
    login, or signing back in with the 30-day `kt_member` cookie, logs every other device
    out. Video Vault shares the pipeline's session instead: `npm run ptrex:connect-iphone`
    (phone unlocked and paired) copies the session into the app's data folder
    (`porntrex-session.json`, via `devicectl`) and relaunches it; the app replaces its
    Porntrex cookies (removing `kt_member`, pinning the rest for 400 days), checks them with
    a fresh request and leaves `porntrex-session-result.json`, which the command reads
    back. Do not log in on the phone: it stops the pipeline; run the command again instead.
    The agent owns recovery and does not require the user to run it: a valid session is
    reused first; coordinated password recovery uses the command's deliberate
    `--allow-password-login` option and leaves manual upload pauses intact.
    `video-ptrex-session.timer` keeps that shared session active while uploads are stopped.
    When the provider invalidates it anyway, the job confirms the failure and restores the
    shared login automatically. Phone delivery failures retry without another password
    login; a valid retained phone session is preferred over creating a replacement.
  - The +/- button asks the PC's three download lists directly (`ViewerPC.swift`).
  - Away from home the lists and Tango's **Log in from the PC** still work (`PCReach.swift`,
    `TangoPCLogin.swift`): the home address `https://192.168.1.197:9999` is asked first for
    2 s, then `https://pc-apps.veron3.space/video` (Hetzner; environment
    `services/hetzner-pc`, "pc-apps"), which passes only `member`, `exists`, `add`, `remove`
    and `phone-session` and asks for `X-PC-Apps-Key`. The key is staged from the PC's
    `~/.local/share/hetzner-pc/keys/video-actions.key` into the ignored `Private/pc-apps-key`
    (`scripts/private_inputs.py`) and built in as Info.plist `PCAppsKey` for Video Vault and
    Tango; without it they are home-only. Home is skipped for 45 s after it failed. A status
    from either address is final, and an add or remove is sent once, to the address that just
    answered the membership question. Recordings (video, save, cut, return), the local apps
    and the Safari extensions stay on the home network.
- **Tango** (`VideoApp/TangoList.swift`) opens with its last list (`tango-list.json`) and
  asks Tango's gateway for a new one behind it: followed streams first, then
  recommendations, one per streamer, never blocked ones; the order then stays while
  browsing (pull down, or return after half an hour, for a new list). Co-streamers found
  while watching join the end, without duplicates, named as found (alias and first name);
  any still without an alias are looked up again (at once, then after 10, 30 and 60 s).
  Ended and blocked streams leave. The overlay has mute, Follow (❤️/🤍), the PC's Tango
  download list (+/-) and Block, which asks once more (❓), unfollows a followed streamer and
  then blocks; follow, block and co-streamers go to the gateway. The session lives in the
  app's cookie jar and `TangoSession` (`Tango.swift`) is its only owner: the session token is
  refreshed from the refresh token when it has under five minutes left (one refresh at a
  time; a rotated refresh token is saved before anything else, as `packages/auth` does), and
  the stream tokens every 5 seconds while a stream plays.
  - The phone is the explorer; the PC pipeline is the backup engine. The phone renews
    its own session directly through `https://www.tango.me/api`, independently of the PC.
    Refresh needs the complete issued device context (`Tango-DI`, `Tango-DeviceId`, SD,
    RT/ST/WST), not RT alone. It commits the coherent replacement pair and auxiliary
    cookies together, retaining the remembered device while the refresh session is valid.
    Usable access stays available during early renewal. One in-flight owner and a bounded
    background assertion protect adoption across app switches/lock; identity and explorer
    state remain saved during outages. Only successful loads start the half-hour freshness
    interval, and reconnect/foreground retries failed requests immediately.
  - The existing PC-login helper is **one-time setup/API migration**. It requires a durable
    request ID, freezes a complete result, stops/clears the setup browser's Tango state,
    and closes before handing ownership to the phone. It does not keep rotating the
    phone's RT in the backup engine. Retries reuse the frozen setup result instead of
    repeating Google login. All desktop/PC auth automation runs on Xvfb `:111`.
  - The current site issues login responses through `www.tango.me/api`. Safari import and
    native credential restoration accept that first-party scope and legacy gateway scopes;
    old paths cannot shadow newer credentials. Credential scopes update in one snapshot.
    The fallback importer uses the active Safari tab's cookie store and derives missing
    session-cookie expiry from the JWT.
  - `tango-network.json` records at most 24 sanitized request outcomes (status/error codes,
    cookie names and native build/source identity), without token values, request bodies or
    cookie headers. `debug-state.json` also identifies the installed native source.
  - Signing in stays the Safari handoff, so Tango works away from home: sign in with Google
    on tango.me in Safari, Import with the Tango Login extension, delete Tango's Safari
    website data and confirm in the app ("Safari data cleared — continue"). Tango Login
    (`Login/`) reads `Tango-RT`, `-DI`, `-DeviceId`, `-ST`, `-WST` and `-SD` for the gateway's
    refresh path from the active tab's own cookie store and saves them in the shared
    Keychain (service `TangoLogin`, account `session`, this device only); the app moves a
    confirmed import into its jar and empties the inbox. (Google refuses sign-in inside an
    app's web view, and no Apple API gives an app the cookies a site sets in Safari.)
  - When the PC answers (at home, or away through its public address) the login screen also offers **Log in from the PC**: the PC
    (`POST /api/tango/phone-session`, packages/server, with the key built into the app from
    `Private/tango-phone-key`) signs in with a fresh browser profile
    (`packages/auth` `phoneSession.ts`), returns that new session and drops the profile, so
    each device holds its own refresh token; the PC's own session is never copied.
  - FC2 live, SC live and Bunkr to PC need enabling once in Safari's extension settings, with their sites
    allowed; their background pages call the PC's `/api/fc2|sc/member|add|remove`.
    Bunkr to PC instead sends the file page to `/api/bunkr/downloads` when the PC
    is reachable: tapping Download on `bunkr.si`, `.ph` or `.cr` queues the original
    video in `~/Videos/plab/bunkr/`. Closing Safari does not stop an accepted
    download. Refreshing or revisiting the file page restores progress from the
    PC automatically; temporary disconnections retain the last progress and
    reconnect without resubmitting. The PC queue and partials survive power loss. Away from the PC the
    normal download link is preserved. See `packages/live-extensions/README.md`
    for queue recovery and the mobile WebKit checks.
  - A Block is real, also in a test. `apps/tango/scripts/tango-unblock-blocklist.mjs` (run on
    the PC) undoes it with the PC's Tango session (`~/.local/share/video-services/session`)
    and the same blocklist endpoint as the app and the server
    (`abregistrar/connection/v1/blocklist`, action `UNBLOCK`). It is a dry run by default;
    `node apps/tango/scripts/tango-unblock-blocklist.mjs --account <id> --execute` unblocks
    one account, `--execute` alone every blocked account (one per second). It reports
    whether anything is still blocked. An unblock shows in the blocklist a few seconds
    later. Adding a streamer to the PC's Tango list (+) also unblocks and follows them.
  - Gateway bodies that are not JSON (follow/add and follow/remove take the account ID,
    the co-streamers' watch the stream ID) are sent as `text/plain` (`Tango.request`).
    Unlabelled, URLSession calls a POST body a form, and follow/add and follow/remove
    answer 500 to that: Follow, Unfollow and Block of a followed streamer did nothing
    until October 14, 2026.
  - Checking the three actions without the phone: the PC's own Tango session (never the
    phone's) can send the app's requests from Node through `packages/shared`'s
    `readTokens()`; follow, then unfollow; block, then unblock; for +/-, the PC's
    `/api/tango/add`, `member` and `remove` with an already followed streamer who is
    offline (nothing records, nothing else changes).
- **One-time migration**: each app's first launch took over what its earlier web version
  kept in WebKit (local apps: the highlight and viewer positions from the website's
  localStorage, through NativeKit's `KitMigration`; Video Vault: its cookies and login-cookie
  backup; Tango: the newest session). A marker file in the data folder
  (`web-storage-migrated`, `cookies-migrated`, `tango-cookies-migrated`) makes each run once.
- Each app keeps its own data in `Library/Application Support/LocalVideos`. No icon or
  launch artwork; the background mode is audio (the native viewer); the only entitlement
  is Tango's Keychain group (`<team>.com.visar.Tango.paid`), shared with Tango Login.

## Build, deploy and inspect

Start with [shared Mac access](../../../../../environment/mac-access.md).
`scripts/deploy.py` runs on this PC and drives the Mac over SSH (`visar@192.168.1.198`,
the runbook's known-hosts file; it falls back to the Mac's Wi-Fi automatically when
Ethernet is down, see `mac-connect --check`). Mac mirror:
`/Users/visar/Developer/video-platform/apps/ios`. The phone
(`00008101-000639912881401E`) is paired with the Mac over Wi-Fi (no cable); paid team
`65U58U86DD`.

Routine delivery uses the durable queue from the repository root
([ios-push](../../../../ios-tools/push/README.md)); it prepares, freezes the source,
builds, signs, installs in place and approves renewal without launching the app:

```sh
ios-push tango-local        # or fc2-local, sc-local, vault, tango (tango-live), bunkr
ios-push status JOB         # only "installed" confirms the phone has it
```

Every provider except Bunkr builds the same `VideoApp` target (module `VideoApp`, product name
from `providers.json`) generated at `build/app/VideoApp.xcodeproj`, in the shared
`build/app/DerivedData` and `build/app/native`; each bundle is cloned to its provider's
`build/<key>/native/` path. ios-push builds these providers in one stable compiler workspace
(`shared` in ios-tools `push/projects.json`), so after a shared change only the first provider of
a batch compiles the app module: on the Intel Mac the following providers took 38–40 s instead of
169–215 s, and a five-app batch finished in 8.6 instead of 18 minutes (signed validation builds).
The stable path matters: the app module does not hit Xcode's compilation cache from another
checkpoint path. Bunkr keeps its own target, builder (`Bunkr/`) and workspace.

The lower-level commands remain for diagnosis, one provider at a time. From this folder:

```sh
python3 scripts/deploy.py <provider> sync      # rsyncs sources to the Mac; Tango also builds its web extensions and stages its PC login key
python3 scripts/deploy.py <provider> test      # the apps' Swift tests, on this PC (scripts/test.sh)
python3 scripts/deploy.py <provider> build     # attached GUI session, signing lock
python3 scripts/deploy.py <provider> status
python3 scripts/deploy.py <provider> install   # verifies, installs over, approves for renewal, launches
python3 scripts/deploy.py <provider> install --no-launch  # leave phone UI checks to the owner
```

`install` checks bundle ID, display name, start URL, the native list key, Tango's PC login
key, extensions, icon absence, signature, paid team, phone provisioning and an expiry more
than 45 days away before replacing the same app. Never uninstall to update (that would sign
the online apps out). No LaunchAgent is created. Simulator builds: `SIMULATOR=1
/usr/bin/python3 scripts/build-provider.py <provider>` on the Mac; they include NativeKit's
test hooks (ios-tools `native/scripts/sim`).

Frame reports: `xcrun devicectl device copy from --device <phone> --domain-type
appDataContainer --domain-identifier <bundle id> --source 'Library/Application
Support/LocalVideos/debug-state.json' --destination <file>` on the Mac, after the app has
left the screen.

### Tests

`test` runs `scripts/test.sh` on this PC (Swift 6.2.4 for Linux, ~9 s; it also runs on the Mac, ~40 s): the registry (`Tests/RegistryTests.swift`),
MP4/HLS local-library URLs, descriptors and offline cache (`Tests/LocalLibraryTests.swift`), Video
Vault's scrapers and list rules (`VaultTests.swift`), and Tango's list rules
(`TangoTests.swift`: the gateway's answers, followed streams first, then recommendations,
one entry per streamer, blocked and ended streams hidden; names from profiles;
co-streamers; the session token's claims), with NativeKit's core, network and HTML modules.
On the PC, `npm test -w server` covers the Tango add route (unblock, then follow) and
`/api/tango/phone-session`, and `npm run test:app:webkit` covers the FC2 live and SC live
bars (`packages/app/README.md`). The rest is checked by hand on the phone, or in a
simulator build through NativeKit's test hooks (without playing video).

`scripts/check-zoom.py` compares saved baseline and candidate simulator builds inside one
guarded visible session. `-zoom-check` selects static calibration fixtures in the actual
viewer and NativeKit strip reader, with no media items, network, audio session or provider
actions. It reproduces baseline portrait clipping, duplicate video surfaces and mid-pinch
reader relayout, then checks fit, stable layer identity, carousel locking, portrait/landscape
zoom, deferred reader metadata and retained image surfaces. The fixtures and their commands
compile only for the simulator; they cannot run in phone builds.

`scripts/check-bunkr-fluidity.py` times the real Bunkr app in the virtual iPhone against the
PC's original files: opening at a saved position, a drag, two jumps, a swipe to the next
video and reopening, with the main thread's frame gaps (`Bunkr/README.md` has the command
and the November 11 results). It plays one 4K video at a time, as the viewer does.
`Tests/InlineKeyframeLandingTests.swift` (PC) checks where seeks and saved positions land.

`Tests/TangoSessionTests.swift` checks single-flight challenge recovery, no re-login during
outages, cooldowns, account preservation, durable cookie scopes and valid-token renewal.
`scripts/check-tango-network.py` drives the actual native list with simulator-only synthetic
HTTP: reconnect, foreground retry, refresh failure, one browser recovery and verification
fallback. It never plays media or contacts a real Tango account. The Safari cookie helper's
PC tests are `node --test apps/ios/Tests/TangoLoginCookies.test.mjs`.

### October 30 zoom verification

The saved baseline reproduced width-only clipping, attachment of a second player layer,
and reader relayout during a zoom gesture. The candidate passed eight aspect/orientation
cases, retained one player layer through the gesture, restored carousel scrolling at
minimum scale, and kept reader images and base geometry stable. Incoming chapter indices
remain available immediately while their new frames wait for zoom completion. Static
calibration screenshots were inspected; no video was played in the simulator and no phone
UI was automated. The owned guest and GUI closed, with no new graphics failure report.

All 17 registered NativeKit app builds were signed and verified, including the unused
reader-module copies in Trader and Guidance. At that checkpoint the phone could not be
reached for installation. The candidates and their sources were staged privately under Mac
`~/Library/Caches/ios-app-refresh/native-zoom-pending-20261030/`; all original renewal-source
hashes were restored and verified against their approved states, leaving the phone unchanged.
PC evidence is `~/.cache/native-zoom-20261030/`. The task's `resume-zoom.py` was prepared to
activate those exact source/artifact pairs after a successful real phone probe.

The away-from-home path was then checked with the owner's phone online on Tailscale.
TCP connected, but the existing paired lockdown handshake timed out and CoreDevice could
not find the device. All staged apps were published through the existing private OTA helper
at `https://mac.tailf47c4e.ts.net:8443/zoom-updates/`. HTTPS page/manifest downloads and
every downloaded IPA hash matched the verified staged packages. Publication alone did not
establish installation; the completion record below supersedes that pending state.

### October 31 delivery and Tango recovery

All 17 updates were subsequently installed in place over the authenticated native phone
connection and approved for renewal. Registered Mac mirrors and signed caches now contain
the delivered source/artifact pairs. The old staging manifest is marked
`superseded-and-delivered`; do not run its historical `resume-zoom.py`. The five video OTA
packages were also republished and their HTTPS downloads verified against the current
signed packages. No product app was uninstalled or had its data reset.

Tango build 25 includes the session, reconnect and verification fixes above, plus the Safari
importer's current first-party cookie scopes (extension version 1.1). A real phone renewal
returned `424 CHALLENGE_REQUIRED`, completed one automatic PC-assisted browser login, and
durably saved the replacement phone session. PC maintenance independently renewed its own
session and obtained a live stream token; phone and PC session families were distinct.
The corrected Xvfb login flow passed. No VPN routing fault was reproduced.

Routine outage, reconnect, foreground and verification UI checks passed on the Mac's virtual
iPhone with synthetic HTTP. The temporary physical-phone controller used for device-specific
diagnosis was stopped, uninstalled and verified absent. The owned guest and Simulator GUI
are closed, with no active workload lease or new graphics failure report. The actual renewal
check covers one controlled cycle, not a long-duration soak.

Sanitized receipts and reports are under PC `~/.cache/tango-off-vpn-20261030/` and Mac
`~/Library/Caches/ios-app-refresh/tango-final-delivery-20261031/`.

## Renewal

The provider builder enters the shared workload guard and limits Xcode to two jobs.
`SIGNING_DESTINATION=generic/platform=iOS` can prepare a signed build while the phone is
unavailable; installation still verifies that the profile includes the configured phone.
An OTA publication is not approved as installed until the actual installation succeeds.

This repository renews its own apps with its Mac scheduler,
`com.visar.renewal.video-platform` ([ios-tools renewal](../../../../ios-tools/renewal/README.md)).
`scripts/renewal.py` lists the monthly entries (Mac mirror `/Users/visar/Developer/video-platform/apps/ios`):
`<provider>-local` (local apps) and `<provider>` (online apps). Their inputs are
`VideoApp`, `Shared`, `Kit`, `providers.json`, `scripts/project.py`, `scripts/build-provider.py`
and, for Tango, `Login`, `Extension`, its staged web extensions and `Private` (its PC login
key). The Mac needs no Node. A new provider in
`providers.json` needs no change outside this repository; rerun `configure-refresh.py` for this mirror.
`install` approves the installed build as that app's renewal baseline, keeping its
renewal date, when neither its inputs nor the app changed since `build`; otherwise it
prints why approval was skipped. No scheduler pause is needed.
`build` re-registers the repository's current extension identities and renewal
inputs before recording its build receipt, so newly added extensions remain in
future renewals.
Every provider's `sync` stages the shared Tango PC-login build key from the
canonical PC state first. Local-app syncs therefore preserve Tango's private
renewal input in the shared Mac mirror. The key is reused, never rotated as a
side effect of building another app; private copies are atomically written with
mode 600. Its temporary-directory regressions are
`python3 -m unittest discover -s apps/ios/Tests -p test_private_inputs.py`.
Installation requires a completed build receipt whose source and app hashes still
match. A concurrent source sync or replacement build must be rebuilt before any
phone installation, rather than merely skipping renewal approval afterwards.

### October 31 persistent-session completion

Tango build 28 was installed and approved with the current shared sources, including
Bunkr local build 2 and its playback policy. All six registered video-app artifacts
were installed in place without resetting data; the other five were not launched.
The phone completed three real native refresh rotations while the PC API was stopped,
with `nativeRenewals=3` and `initialSetups=0`. Ordinary phone renewal is independent
of the backup engine. The PC recording session also completed natural hourly renewals
with its original session family and no new Google login. X11 window PIDs verified
that PC authentication was on Xvfb `:111`.

Native session/cookie rules, one-time ownership transfer and interrupted delivery tests
passed, along with the Mac virtual-iPhone outage, foreground, reconnect and setup-TLS
checks. No WDA or physical UI automation was used. Current signed OTA packages were
republished and HTTPS hashes verified. Private receipts are under
`~/.cache/tango-hardening-20261031/` on the PC and
`~/Library/Caches/ios-app-refresh/tango-hardening-20261031/` on the Mac. The protocol
checks cover controlled rotations and observed PC hourly renewal, not a multi-day soak.

Video visibility and playback are separate rules. At rest and while zoomed, only the current
video is visible. During unzoomed vertical scrolling, neighbouring videos appear without
changing the content offset when scrolling stops. All VOD apps pause neighbours; Tango live
keeps its neighbours playing muted. Zoom disables carousel navigation. Old restoration
posters containing neighbouring videos are ignored; new posters capture only the current one.

Local lists include PC-probed display width/height, accounting for pixel aspect ratio and
rotation; these dimensions persist in the list cache. Tango live reserves720×1280. A viewer
keeps its reserved geometry stable when decoder metadata/resolution arrives. Unknown Vault
clips reserve a viewport so their first picture cannot become a miniature portrait. Actual
dimensions are retained in `viewer-dimensions.json` for later visits. Trusted OG/flashvars
video dimensions are used when the playback page supplies them; CSS player size is ignored.

Bunkr performance code is isolated in `Bunkr/`: its decoder adapters, player/model
overrides and build settings are selected only for the Bunkr target. The five
other apps use the original shipped shared engine (`b09884d`), including the
accepted scroll/visibility and recording-variant fixes. Their current login/API
contracts are retained. The HLS server serves the stored playlist and fragment
bytes directly; it does not derive decoder epochs or replacement initializations.

## Explicit state transitions

Runtime workflow states and ownership invariants are catalogued in
[the shared state inventory](../../../../ios-tools/native/state-machines.json).
Tasks may publish only for their current owner. A cancelled caller releases its
own transfer lease, and callbacks from an older operation cannot finish a newer
one. Playback intent, readiness, terminal media, foreground ownership and gesture
visibility are separate machines. Recovery reuses the existing durable data and
bundle identities; it does not clear sessions, progress or caches.
