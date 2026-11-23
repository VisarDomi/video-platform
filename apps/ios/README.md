# iPhone apps

One engine builds every app: native lists with a native viewer over them, playing the PC's
recordings, a file host's original files or a site's own streams. No app shows a website.

| Folder | What it is |
|---|---|
| `App/` | The engine: lists, the viewer and its players, the PC's recordings library, the PC's download lists, state machines, simulator walk-throughs |
| `Providers/<name>/` | A provider plug-in: a site's own list (and anything it needs), named in its `plugin.json` |
| `Kit/` | NativeKit, vendored (its canonical copy is in ios-tools `native/Kit`) |
| `Extension/` | The no-op native side of a hosted Safari web extension |
| `scripts/` | The generator, the builder, the signing declaration, the walk-throughs and timings |
| `Tests/` | The engine's logic tests (Swift for Linux) and the provider-pattern checks |
| `apps.json` | The demo's registry: its apps and plug-ins |

The demo's apps, against the simulated sites (`deploy/demo`):

| App | Key | What it is |
|---|---|---|
| Wimbledon local | `live-a-local` | The PC's recordings of the simulated site A (`ts-live`): the list, the viewer (play, scrub, zoom, the next recording), save (✅), cut, return, markers |
| Wimbledon | `live-a` | Site A itself (`Providers/live`): the followed accounts that are live now, playing with short-lived stream tokens; follow; "+" puts an account on the PC's download list |

The live app's session is the phone's own token family. The first one comes from the PC
(`LivePCLogin.swift`, the server's `/api/<site>/phone-session`): the PC signs in with its own
account and asks the site for a family for the phone, hands it over once under a durable
request ID, and keeps none of it. From then on the phone renews it itself, one refresh at a
time, saving each rotated refresh token before it uses the new session.

## Registries, plug-ins and deployments

A registry is a folder with an `apps.json` (and an `apps.local.json` beside it, never in Git):
its apps, its plug-in folders and its settings (`scripts/registry.py` documents every field).
This folder is the demo's registry. A deployment keeps its own folder with its apps, its
provider plug-ins, its keys and a link named `engine` to this folder, and builds with this
engine:

```sh
python3 engine/scripts/project.py --registry . APP     # the Xcode project and Info.plist
SIMULATOR=1 python3 engine/scripts/build-app.py --registry . APP
python3 engine/scripts/renewal.py --registry . --team TEAM --device UDID
```

Every app of a registry is the same target, `VideoApp`, compiled from the same sources (the
engine and all of the registry's plug-ins), so the apps share compiled modules and a batch
compiles the app module once. What tells them apart is the Info.plist the generator writes:

- `LocalProvider` and `LocalMediaKind` (`hls`, or `file` for original files), or `NativeList`,
  a plug-in's site list;
- the provider traits (`App/ProviderTraits.swift`): `LiveProviders` (live streams; their
  neighbours keep playing, frames are 9:16 unless the list says otherwise),
  `OriginalFileProviders` (a file host's library: file IDs and renaming on the PC) and
  `ListNames` (the download lists' names for the +/- button);
- `PCServer` and `PCAwayServer`: the PC on the home network and, optionally, its public address
  for the download lists (`App/PCReach.swift`);
- `StartURL` (an app's own `url`, else the PC), `LiveSite` and `PhoneKey` (a live site and the
  PC's key for its phone sign-in), and any `keys` an app names: Info.plist values read from
  files in the registry folder, never in Git.

A plug-in's `plugin.json` names its lists (`"lists": {"live": "LiveListController"}`, a
`SiteList` that builds itself from the Info.plist) and its simulator checks (`"checks":
{"-site-check": "SomeChecks"}`); the generator writes `Plugins.generated.swift` from them, so the
engine never names a plug-in. Files ending in `Checks.swift` enter only simulator builds. An app
with `overrides` names a folder with its own generator, builder and engine files of the same
name (a provider whose playback engine differs, e.g. original 4K files with native decoders).
An app's Safari web extensions are staged by the deployment in `build/<app>/<extension>/`.

### The provider pattern

The engine names no provider. Per-provider behaviour comes from the registry's traits, from a
plug-in's own files, from the stream kind (live streams keep their neighbours playing, VOD
parks them: `ViewerPlaybackPolicy`), or from an override folder. `Tests/test_engine.py`
enforces it: no comparison of a provider with a literal, no plug-in type in the engine, no key
test in the generators; and that every app of a registry compiles the same sources, that
checks stay out of phone builds and that every declared build input exists.

## Settings

`apps.local.json` beside `apps.json` (never in Git) sets a deployment's own values over
`apps.json`'s:

```json
{"bundlePrefix": "com.example", "pcServer": "https://192.168.1.10:29999", "pcAwayServer": "",
 "liveSites": {"ts-live": "https://192.168.1.10:28081"}, "phoneKeys": {"ts-live": "<the PC's ts-live-phone-key>"}}
```

Without it the apps expect the demo pod (`deploy/demo`) on the same machine: the PC at
`https://localhost:29999`, site A at `https://localhost:28081`. The phone key is the PC's
`~/.local/share/video-services/ts-live-phone-key`; for the demo, the `ts-live-phone-key` in its
settings folder (deploy/demo/README.md, "On demand"), which every fresh start reuses.

## Behaviour: native lists with a native player

- **Videos play in a native viewer** (`App/Viewer*.swift`) over the list, because WebKit pauses
  a page's video whenever the phone locks or the app leaves the screen. Videos play on through
  lock and the background until they end (background audio), and nothing pauses, reloads or
  jumps on the way back.
  - At minimum zoom every video uses the largest aspect-preserving size that fits both
    viewport dimensions. The document is continuous: vertical scrolling moves through the list
    with neighbours appearing and touching only while it moves, no blank runways or snap
    positions, and lifting a finger never moves it. At rest and zoomed only the current video
    shows.
  - The upper half's horizontal drag seeks (60 s per screen width); the lower half's swipe shows
    or hides the controls. The overlay has mute, follow, block, +/-, save/cut/return and
    markers (the last two only for the PC's recordings). Videos start muted; progress is saved
    every 3 s.
  - A pinch zooms the current video anywhere. Zoomed, the list stays put and drags pan the
    picture, except the upper half's seek. The left edge slides the viewer away to the list,
    and the list's right edge brings the last viewed video back at its saved time.
  - The viewer asks the list for what only the provider can do (`ViewerHost.swift`: playback
    sources a list does not carry, co-streamers, follow, block, a sign-in). Recordings and live
    playlists come with the video, so playback never waits on the list; a live site whose
    playlists need short-lived tokens serves them through `TokenPlaylists`. Edits and the +/-
    download lists go to the PC directly (`ViewerPC.swift`).
  - Unmuted, the viewer takes the audio and shows on the lock screen with play/pause, a
    scrubber and next/previous; muted, it mixes with other apps. A failed or stalled video
    recovers at its position; a live stream that ended (or plays without a picture for 3 s)
    gives way to the next.
  - A killed app reopens its viewer (`viewer-checkpoint.json`, written off the main thread) at
    the picture's exact place, zoom and controls; progress is `viewer-progress.json`.
- **Loading order.** The opened video gets the network first: its saved position is asked for
  before its item loads, and its neighbours load once it plays. A neighbour is parked paused at
  its saved position with two seconds ahead, so a swipe starts at once without hidden
  neighbours downloading beside the watched video. See "Opening and scrubbing speed" below.
- **OK, Cut and Return Original** keep the moment being watched (`VariantPosition.swift`): OK
  and Return Original move the same playlist, so playback continues at the same second; a cut
  keeps whole segments in order, so a moment inside a kept one keeps its place in it and one in
  a removed stretch continues at the next kept moment. The variant replaces the recording
  atomically (layout slot, reserved geometry, player and checkpoint), whether the action's
  acknowledgement or the PC's change feed arrives first.
- **Lists** (`App/VideoList.swift`) show a 52-point row per video with its name (red while
  recording or live, orange when edited), duration and size; the last viewed row is
  highlighted. The list's place is kept across kills. A new list keeps the rows on screen in
  place, and one that arrives while a finger or momentum moves the rows waits until they stop.
- **The main thread only shows.** A list applies changes and describes its rows in the
  background, rows are compared by what they show (`ViewerVideo.Look`), writes go to
  background queues (except when the app leaves for the background, which waits for them), the
  audio session switches on its own queue, and the next viewer is built ahead while nothing
  moves (`prepareSpare`). NativeKit's FrameMonitor keeps every frame over 25 ms with the spans
  of our code in it, in `debug-state.json` ("frames").
- **Relaunch**: the first frame is the screen as it was left; a restored viewer shows its saved
  picture (`viewer-poster.jpg`) until the player draws its own.
- **The PC's recordings** (`App/LocalList.swift`) are kept on the phone (`list-cache.json`), so
  they show at once, offline and after a kill, and follow the PC's change feed
  (`/api/videos/changes`, one long poll at a time while on screen).
- **The PC's download lists away from home** (`App/PCReach.swift`): the home address is asked
  first for 2 s, then the public one (`PCAwayServer`, with the key an app carries as
  `PCAppsKey`); home is skipped for 45 s after it failed; a status from either is final; an
  add or remove is sent once, to the address that just answered.
- Each app keeps its data in `Library/Application Support/`. No icon or launch artwork; the
  background mode is audio; no entitlements beyond the application identifier.

Runtime workflow states and ownership invariants are separate machines (playback intent,
readiness, terminal media, foreground ownership, gesture visibility: `VideoPlaybackState`,
`ChasingSeek`, `ViewerInteractionState`); callbacks from an older operation cannot finish a newer
one, and recovery reuses the durable data instead of clearing it.

### Opening and scrubbing speed

The continuous document gives every video it shows a player: at rest about seven, six of them
hidden neighbours. Neighbours wait for the current video to play, and a parked neighbour asks
AVPlayer for 2 s ahead, which it honours (about 1 MB, then idle). AVPlayer treats a smaller
request, such as 0.5 s, as automatic below a segment: in the virtual iPhone every hidden
neighbour then downloads 15-30 MB within five seconds of opening (about 150 MB), beside the
watched video's first segment and every later seek. A saved position is asked for before the
item loads, so the 0:00 frame never flashes first. Measured with `scripts/check-fluidity.py` on
three recordings (720p and 1080p) opened at 5:00, the PC mirrored at a shared 100 Mbps like a
phone's Wi-Fi, with this policy and with the opposite one (neighbours load at once and ask for
0.5 s; the saved position is set after the item loads):

| Step | Opposite policy | This policy |
| --- | --- | --- |
| Open until playing | 6.5, 3.9, 4.1 s | 0.74, 0.90, 0.30 s |
| +45 s drag: release until playing | 2.5, 1.3, 1.5 s | 0.13, 0.25, 0.55 s |
| Jump +200 s until playing | 1.1, 1.2, 1.7 s | 0.9, 0.6, 0.7 s |
| Jump back to 0:20 | 0.7, 1.0, 1.2 s | 0.6, 0.4, 0.35 s |
| Swipe to the next video | immediate | immediate |

The simulator's ~200 ms frame gaps while dragging are its renderer's (the app's main thread was
sampled idle), so they are no measure of a phone.

## Signing for a phone

`scripts/renewal.py` declares a registry's apps to a signing service (ios-tools' `ios-push`,
which builds on the Mac, signs, and installs or publishes for an install from anywhere): name,
bundle ID (an app's `bundleId`, or `bundlePrefix` + its `bundleSuffix`), inputs, and
`scripts/build-app.py APP`, the signed device build (`DEVELOPMENT_TEAM`, `SIGNING_DEVICE`). It
builds in `build/app` and clones the bundle to `build/<app>/native/Release-iphoneos/`. On the
Mac it enters ios-tools' workload guard and the shared signing lock. Never uninstall an app to
update it and never change a bundle ID: iOS keys an app's data and logins to it.

## Building and checking on a Mac

```sh
scripts/build-check.sh live-a-local        # an unsigned Debug simulator build (x86_64)
SIMULATOR=1 python3 scripts/build-app.py live-a-local   # Release, as the walk-throughs use
python3 scripts/check-local.py --device UUID --app build/DerivedData/Build/Products/Debug-iphonesimulator/WimbledonLocal.app \
    --out /tmp/qa-local --cert demo-cert.pem --save
python3 scripts/check-live.py --device UUID --app .../Wimbledon.app --out /tmp/qa-live --cert demo-cert.pem
```

The walk-throughs drive a simulator build through its test hooks (`Kit/Sources/KitTestHooks`,
simulator builds only) and leave a screenshot per step and a `report.json`:

- `check-local.py`: the list matches the server's, the first recording plays, the next one,
  zoom, back to it highlighted, a recording still being captured plays at its live edge;
  `--save` saves the first original with ✅ and waits for the server to list it as kept;
  `--offline` expects the list's failure message with the PC unreachable.
- `check-live.py`: from a fresh install the PC signs the phone in, the followed streams list
  and play, playback outlives the stream tokens (about 10 s), the next stream plays, and a
  relaunch shows the kept list at once and refreshes it without the PC.
- `check-fluidity.py --bundle ID --rows ...`: opening at a saved position, a +45 s drag, two
  jumps and a swipe, with when the picture and steady playback arrive, the main thread's frame
  gaps and how many players held an item (`App/FluidityChecks.swift`). `pc-mirror.py` stands in
  for the PC on the Mac when it is away: a chosen list and every playlist and segment fetched
  once through an SSH tunnel and served from its cache, optionally capped to `--mbps`.
- `check-zoom.py --bundle ID`: static calibration fixtures in the real viewer and NativeKit's
  strip reader (`-zoom-check`, no media or network): fit, stable layer identity, carousel
  locking, portrait and landscape zoom, deferred metadata.
- `check-navigation.py --bundle ID --kinds provider=kind,...`: list place, back, forward,
  relaunch and the variant transitions over 120 static rows per provider kind (recordings,
  files, site, live).

On the shared old Intel Mac, simulator playback checks decode one stream at a time (the viewer
parks its neighbours) inside the guard, with no parallel video test. `--cert` adds the demo's
certificate (it names `localhost`) to the simulator once. A Mac that is not the PC reaches the
demo through forwarded ports, e.g. `ssh -N -R 29999:127.0.0.1:29999 -R 28081:127.0.0.1:28081 mac`.

Known on the Intel Mac's iOS 26.3 simulator: emoji draw as boxed question marks, so the
overlay's emoji buttons show "?" and come out wider than on a phone. The walk-throughs find the
buttons by their text; a phone draws them normally.

## Tests

`scripts/test.sh` runs the engine's logic tests on the PC (Swift 6.2.4 for Linux through
`Kit/Linux/swift-env.sh`; the Mac works too): playback intent and seek ownership, the gesture
and carousel state machines, 8,000 fitted feed frames, the playback policy, where a variant
change continues, the recordings library and the PC's two addresses; then `Tests/test_*.py`
(the provider pattern and the registry tooling). `scripts/check-local.sh` at the repository
root runs it when a Swift toolchain is present. A deployment's own test run starts with it.
