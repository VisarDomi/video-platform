# Stream Viewer native apps

Tango is the first native provider. The app uses the existing Stream Viewer
home, reader, CSS, three slots, Multi, controls, co-streamers, and immediate
scrollend behavior. There is no copied provider UI, added tab bar, PC dependency
for playback, SOC, VLC, or persistent media download queue. Xvid remains a later
provider; its native build is deliberately disabled until its auth boundary is
implemented.

## Shared build pattern

`src/provider/providers.json` is the provider registry used by hostname selection
and the required-provider iOS builder. `npm run build:ios -- tango --prepare-only`
bundles only Tango and the shared UI. Missing, unsupported and multiple providers
are rejected. One Swift host and generated project serve the selected provider.
Do not create a separate source tree for the next provider.

The app adapters replace only document takeover, HTTP transport, authentication,
and durable app checkpoints. The shared Tango provider still owns list/extraction,
profile enrichment, follow/unfollow, block and optional PC download-list requests.
Its original JSON Accept header is preserved; omitting it returned a non-JSON
response in the first native list test. The userscript keeps its browser HTTP
implementation through `src/core/request.ts`.

Cold launch builds a fresh home list, resolves the saved current streamer against
that list, then opens the live stream with Home beneath it for WebKit Back.
Bootstrap Home cannot overwrite the reader checkpoint. Web documents keep their
existing sessionStorage handoff and bfcache behavior. Native storage contains only
route, current streamer, home position and Multi preference; no stale media URL
catalog or copied account credentials. Late saves from inactive documents are
ignored. The one WKWebView retains native back/forward gestures and inline videos.

## Authentication and streaming

Read [AUTH-INVESTIGATION.md](AUTH-INVESTIGATION.md) before investigating credentials.
The original iPhone login test passed all four checks with HTTP 200. Preserve:

- App `com.visar.Tango.paid`, display name **Tango**, no custom icon.
- Helper `com.visar.Tango.paid.Login`, display name **Tango Login**.
- Paid team `65U58U86DD`; Keychain group `65U58U86DD.com.visar.Tango.paid`.
- Keychain service `TangoLogin`, account `session`, device-only protection.

The helper belongs to Tango; Reader Extensions can be removed independently. It
runs only from an explicit popup Import. It locates the active Safari tab's cookie
store and reads the path-restricted RT plus device/session cookies. Import remains
pending until the user closes Tango tabs, deletes only local Tango Safari website
data and confirms in the app. Never use website logout or revoke the copied
session. After handoff, the helper may stay disabled. New login is needed only if
the saved refresh credential expires, is revoked or becomes invalid.

`TangoAuth` is the only native session owner. Refresh is single-flight across all
page/API/media callers; the replacement RT is saved immediately, before tokenData
or other fallible requests. It uses the current v2 web refresh endpoint, not Video
Platform's historical username-header endpoint. The active app refreshes playback
credentials approximately every five seconds and its session after 30 minutes.
Backgrounding stops the maintenance loop, pauses playing videos, and gives an
already-running refresh time to save before suspension. Foregrounding renews
playback credentials and resumes only videos that had been playing.

Direct WebKit HLS failed in the initial physical app. The working native transport
uses the same principle as Video Platform's removed TL relay (see commits
`a7338be` and `fe302c8` there): supply fresh tt/ttu/tte to Tango playlists and relay
media. The relay is **inside this app**, bound only to 127.0.0.1 on an ephemeral
port, with an unguessable per-launch path and registered opaque resource IDs.
It rewrites master/variant references and quoted HLS URI attributes (keys, maps,
audio), preserves byte ranges and forwards media in memory. The original master
playlist is kept, so WebKit selects quality; the old TL 720p restriction was not
ported. No RT/ST enters WebKit or the relay URLs. Playback cookies go only to Tango;
redirects to unrelated CDNs drop the explicit Cookie header. Old segment mappings
expire. Initial playlist mappings remain for cached-page resume during this launch.

The PC is used only for the original optional download-list controls. Its public
local CA is pinned to 192.168.1.197 and still checks hostname/validity. No accept-all
TLS handler, PC account-token copy, server relay or new synchronization pipeline.

## Build, deploy and inspect

Start with [shared Mac access](/home/visar/Documents/environment/mac-access.md).
Mac mirror: `/Users/visar/Developer/stream-viewer/apps/ios`.
Phone: `00008101-000639912881401E`. Use the trusted SSH options from that runbook.

From this repository:

```sh
npm run build:ios -- tango --prepare-only
npm run tests:ios
node --test apps/ios/cookies.test.mjs
npx tsc --noEmit -p apps/ios/tsconfig.json
python3 apps/ios/scripts/deploy.py tango sync
python3 apps/ios/scripts/deploy.py tango build
python3 apps/ios/scripts/deploy.py tango status
python3 apps/ios/scripts/deploy.py tango install
python3 apps/ios/scripts/deploy.py tango finish
```

Wait for no PID, exit 0 and BUILD SUCCEEDED. The installer validates host and helper
identity, paid team, phone provisioning, expiry, shared Keychain entitlement,
signature and icon absence before replacing the same app. Never uninstall to
update. The builder uses the suite signing lock and supports its inherited FD.
The GUI LaunchAgent supplies the logged-in Xcode Keychain session. DerivedData,
project and plist outputs live under build/tango; sync does not overwrite Mac
native outputs. Do not modify prepared inputs during a build or renewal.

Offline Swift auth/relay checks run on the Mac without real accounts:

```sh
cd /Users/visar/Developer/stream-viewer/apps/ios
xcrun swiftc -parse-as-library App/TangoAuth.swift App/MediaRelay.swift \
  App/LocalTrust.swift Shared/Login.swift tests-auth.swift -o build/auth-tests
build/auth-tests
```

Use the existing inspector-venv Python with
`scripts/app-inspector.py --host-bundle com.visar.Tango.paid --seconds 12`.
Snapshots expose only page/count/media status. No Console/Network payload dumps.
`--evaluate-file` may execute a bounded diagnostic/navigation script. Async results
must be stored in a safe scalar/status object and read after completion; the remote
Runtime.evaluate result does not await arbitrary promises. Attach only one
inspector at a time and reconnect after navigation. Never replay the live RT on a
Mac/PC diagnostic client; it consumes a rotating credential.

The native `diagnostics` bridge returns counters and HTTP status counts only.
Navigation state is session-only; there is no device view checkpoint (build 10 onward).
Credentials remain in Keychain, not diagnostic JSON or backup files.

## Renewal and recovery

Register `--stream-root /Users/visar/Developer/stream-viewer/apps/ios` with the
Reader Extensions `scripts/configure-refresh.py`, retaining all existing manga,
gallery, gallery-reader and Ytb roots. The existing installed-app scheduler then
uses the prepared provider registry/bundle and shared native builder monthly.
There is no separate Tango scheduler. Pause only an idle scheduler, install/test
the intended baseline, approve that baseline, verify renewal and resume it.
Refresh `/home/visar/Documents/environment/mac-renewal` when configuration changes.

See verification.json for measured device tests and remaining manual coverage.


## Delivery checks

The user manually verified video scrolling and accepted the app. Physical iPhone
inspection confirmed 720×1280 decoding, advancing live playback, and 200/206 relay
responses while playback credentials renewed. The same stream played after a
background/foreground cycle. The auth/relay fixture also covers single-flight
rotation, replacement persistence before failed playback, the 30-minute session
boundary, master/variant/key/init/segment rewriting, Range forwarding, and cookie
scoping. Browser fixtures cover UI parity, Multi, a fresh list on cold launch,
streamer reanchoring and Back; the unchanged extension's scroll/provider/cookie
fixtures pass too. Follow/block/download mutations were not performed against the
real account.

Initial paid renewal succeeded on USB at 2026-09-12 22:29 UTC (September 13 local
time). Both profiles advanced to September 12, 2027 22:27:53 UTC; next monthly
renewal is October 12, 2026 22:29 UTC. An initial multi-target provisioning build
referenced a profile Xcode had just replaced. Retrying the existing runner reused
the newly generated wildcard and succeeded; no new renewal workaround was added.
The other eleven app configurations were compared and preserved unchanged.

User clarification: killing/reopening must fetch a fresh list; restoring the
current streamer afterward is wanted. Do not remove the checkpoint or change
that behavior. Ordinary navigation/Back and background resume reuse the current
session, matching the existing viewer's stable-list behavior.


Final physical SIGKILL/relaunch also passed: saved selection and Multi matched
before/after, the reader reopened, and the current video advanced from 73.63 to
79.64 seconds with readyState 4. This check ran after paid renewal. The renewed
signed Web resource matches the prepared bundle SHA-256 in verification.json.
All twelve monthly entries were enumerated successfully after scheduler resume;
no further builds were due. Temporary build/renewal jobs were unloaded.

Back from the restored stream returned to the freshly fetched Home list (140 rows
in the final physical check). The app was left on Home, ready for normal use.


## Temporary Xvid Safari extension inside Tango (build 7)

The user deferred the native Xvid port. Tango now embeds an independent Safari
extension **Xvid**, `com.visar.Tango.paid.Xvid`, beside **Tango Login**. Its content
script is byte-for-byte the previously delivered Reader Extensions runtime:
`fb73c7754f18fb24b76a3cb2014807a9ce569cef2a7b68606a07365c14725142`.
Only the package name and manifest site scope change: xvideos.com and
www.xvideos.com. The existing Safari login, cookie persistence, uploads list,
player and scroll behavior remain unchanged. There is no native Xvid auth port,
new Tango permission, credential transfer or shared Keychain access for Xvid.

The initial relocation used Reader Extensions' staged bundle. That build-time
coupling has now been removed: `scripts/build-ios.mjs` runs this repository's
`build-extension.mjs`, then packages its own `dist/extension` output into
`build/tango/Xvid` with XVideos-only name/site scope. A fresh Tango build needs
no Reader Extensions checkout or staged artifact. No duplicate Xvid provider or
reader implementation is introduced. Native renewal consumes the prepared Xvid
resources and includes all three bundle identities from the provider registry.
Both extension targets must be embedded and signed.

Verified standalone preparation in a temporary checkout with no sibling Reader
Extensions repository, plus native UI/provider fixtures. The installed extension
identity stays the same; this packaging correction requires no Safari re-enabling.
The hash above records the earlier delivered build, not a fixed future payload.

After installing the updated Tango app, Safari requires the user to enable the
new **Xvid** extension and grant XVideos website access. Disable the old **Stream
Viewer** entry if Reader Extensions is still installed, then reload XVideos.
Once Xvid is enabled, Reader Extensions can be deleted from the phone. Tango
continues to host Xvid; website data/login remain in Safari. The user handles
Reader Extensions deletion. The scheduler skips the removed host automatically.

Verified after user enablement: physical Safari clean reload had one startup,
ready=true, no startup error and 187 viewer rows. No new video playback test was
performed for this packaging-only move. The renewal check updated all three
profiles to September 12, 2027; next Tango renewal is October 12, 2026. The normal
monthly scheduler was resumed successfully and enumerated eleven installed paid
apps, including Tango; Reader Extensions was absent and skipped. Recovery
configuration/scripts/evidence are copied into environment/mac-renewal.

## Follow request parity fix (build 8)

The native port omitted the implicit content type supplied by browser XHR for
string request bodies. A credential-free wire test showed browser XHR sending
`text/plain;charset=UTF-8` and URLSession sending
`application/x-www-form-urlencoded`. Physical Follow failed with HTTP 500;
changing only this header in the same app/session returned 200 and updated the
heart. The historical Video Platform TL client (`fe302c8^`, Tango apiClient)
similarly relies on fetch's string-body default, with Tango-ST authentication.
No additional credential or refresh ownership change was needed.

TangoAuth now supplies the browser string content type only when a body exists
and no explicit content type was supplied. JSON requests, including Block, retain
their declared type. Shared provider/UI code and the Xvid payload are unchanged.
The regression test failed before the fix and passed afterward. Swift tests also
cover Unfollow and Block headers; browser fixtures cover Follow/Unfollow state,
Block's confirmation, unfollow-before-block, and removal from the reader list.

Physical build-8 verification: Follow and Unfollow returned 200 with the app's
unmodified native transport. The user's requested Follow was retained. Block
returned 200/error_code=0 and membership subsequently showed the streamer blocked.
For test cleanup, use the same current blocklist endpoint with JSON
`{action:"UNBLOCK",account_id:[id]}`; it returned 200/error_code=0 and a fresh
blocklist read confirmed absence. The historical DELETE `/public/v1/blockList`
returned 200 but its immediate read did not confirm cleanup; do not use that
status alone as proof. Follow was restored after cleanup. This is a diagnostic
cleanup operation only; no Unblock control or new runtime API was added.

Keep credentials in the native owner. Read only scalar status/membership results
from inspectors, never sessionStorage objects or raw response payloads. There is
no need to repeat login, copy another token, or refresh on the Mac.

Final independent account read confirmed blocked=false and followed=true. Build 8
then passed paid renewal for host, Login and Xvid; monthly scheduling was resumed.
The first renewal hit the previously observed wildcard profile replacement race
(missing mobileprovision input); rerunning the existing job succeeded. Recovery
scripts, renewal evidence and checksums are updated in environment/mac-renewal.


## Fidelity audit — September 13, 2026

The first four-codebase pass checked the shared routes/provider, required-provider
builder, native request/auth and lifecycle/checkpoint boundaries. Existing native
fixtures and TypeScript checks passed, including Follow/Unfollow/Block, Multi,
fresh cold lists, streamer reanchoring, Back and stale saves. No new demonstrated
mismatch was found in those checked flows; no further runtime change was made.
The prepared app.js still hashes to
`af6234ff1b84306336fbc8bd5251210c374e6d39fe3a82dd1081a24ae39f840e`,
and the hosted Xvid payload is unchanged. Real account actions were not repeated;
the build-8 restoration evidence above remains the actual device test.
See Manga Reader's `investigation/port-fidelity-audit.md` for scope and limits.


## Second fidelity pass — September 13, build 9

The native bundle still imports the source Home, reader, gestures, CSS and Tango
provider. This pass changes native state/transport adapters only; the userscript
and Xvid runtime are unchanged. Inspection of a freshly built extension against
the staged Xvid payload found only the existing provider-registry and Tango
request extraction refactor, with the same XVideos behavior. Keep the delivered
Xvid SHA256 above; there is no need for another extension enablement.

Confirmed and corrected differences:

- A reader opening with a slow profile or media response kept the native
  checkpoint on Home until `startViewer` finished. The adapter now records the
  destination before those awaits. Cold reopening clicks the actual shared Home
  row, establishing the selected streamer before loading the destination.
- Click/scroll-only saves missed asynchronous source transitions such as an
  unavailable/blocked stream being removed. A build-time state adapter delegates
  to the unchanged source `saveState`, then checkpoints that exact transition.
  Scrollend saves run after the source's settlement handlers. No delay is added.
- Cold reader navigation left Home at the top, and a rebuilt Back entry did not
  restore the list position. Home position is restored before cold auto-navigation
  and when WebKit rebuilds a Back entry. Cached pages retain native navigation.
- The HLS relay retired cached variant, key and initialization registrations after
  120 seconds, so a player reusing them could receive a local 404. These references
  now live for the relay session, as root playlists already did. Live segment/part
  registrations still expire; no media payload is saved to disk. HEAD now reports
  the GET representation length while returning an empty body.

Regression evidence includes a failing delayed-reader checkpoint fixture before
its fix and a failing cached-key/init expiry fixture before its fix. The browser
suite now checks early normal/cold restore, asynchronous replacement, scrolled
Home Back, Multi, and foreground pause/mute preservation. The Swift fixture uses
an injected clock to check cached playlist/key/init reuse beyond 120 seconds,
obsolete-segment eviction and HEAD, in addition to existing auth/HLS tests.
Use the normal test/build/install commands above. Real account Follow/Block
mutations are unnecessary; their prior physical proof and current fixtures remain.

Physical deployment and renewal results are recorded in
`second-pass-verification.json`. Recovery must keep the new web state adapter and
MediaRelay together with the current provider-built host. No signing identity,
login handoff, account state, monthly policy or product UI change is required.

Build 9 physical results: decoded 720×1280 live playback with advancing time and
HTTP 200/206; force-kill reopened the same streamer against a changed fresh list;
foreground playback resumed; Back restored Home to scrollY 600 (129 current
rows). Follow/block state was not mutated. The normal monthly job renewed build
9 and both helpers, with matching approved source/assets and no icon. Its first
attempt referenced a missing Xcode provisioning profile; retrying the unchanged
job succeeded. Scheduler is active/idle, last exit 0. The detailed evidence
contains the new profile deadlines and next due time.

## September 22: Tango cold launches start fresh (build 10)

This supersedes the cold-stream restoration described in the historical build 9
sections above. Every new app process opens Home at the top and fetches a fresh
list. No `view.json` is read or written, and the native stream-state build adapter
has been removed. Existing old checkpoint files are unused; no migration is needed.

The shared userscript's sessionStorage still retains the list and selected stream
for navigation within the running app. Native Home offset is held in memory only
for reconstructed Back pages; WebKit handles cached Back pages. Login remains in
Keychain and the Multi preference remains a setting. Authentication renewal, HLS
relay and network recovery are unchanged by this request. Web content process
termination opens a fresh Home instead of restoring the previous stream.

The native-bundle fixture now uses WebKit and checks fresh cold Home, a new list
revision, session Back position, pause/mute and the existing account-action fixtures.

Build 10 physical check: Home had 143 rows; the selected stream decoded and played
720×1280 video. Back returned to the same list at scrollY 600. Force-terminating
from that stream and relaunching opened Home at scrollY 0, no selection, and a
fresh 146-row list. Login stayed available. No live account actions were changed.
Network interruption was not retested for this change; its existing implementation
is untouched. See `fresh-launch-verification.json`.

The existing monthly renewal installed build 10 and both helpers successfully;
all profiles expire September 22, 2027. The first attempt hit the previously
documented cached-profile replacement race; retrying unchanged succeeded. The
normal scheduler is restored. No new LaunchAgent was created for this work.

## October 2: Xvid uses Video Platform's shared frontend (build 12)

This supersedes the Xvid source/packaging statements in the build 7 section.
Xvid remains `com.visar.Tango.paid.Xvid` inside the same paid Tango app. Its UI now
comes from the sibling `video-platform/packages/app/src` codebase, sharing the
website's actual list, CSS, player, overlay, timeline and gestures. Local providers
retain save/cut/return/download-list operations; XVideos is an online consumer and
hides those controls. Its Safari session/cookie persistence, uploads pagination,
native account/management pages and highest-quality extraction are preserved.
Duration is read from uploads metadata; file size is estimated at 4 Mbps.

Keep the repositories as siblings and install dependencies in both. Prepare from
stream-viewer:

```sh
npm run build:ios -- tango --prepare-only
npm run tests:ios
python3 apps/ios/scripts/deploy.py tango sync
python3 apps/ios/scripts/deploy.py tango build
python3 apps/ios/scripts/deploy.py tango status
python3 apps/ios/scripts/deploy.py tango install
python3 apps/ios/scripts/deploy.py tango finish
```

The preparation invokes `video-platform/packages/app/scripts/build-extension.mjs
xvideos`, then stages `video-platform/dist/extension/xvideos`. Reader Extensions
is not involved. The native Tango Web payload is unchanged. Tests check that the
staged Xvid payload exactly matches Video Platform's output. Source ownership and
WebKit checks are documented in `video-platform/packages/app/PROVIDERS.md`.

The deploy helper now builds in an attached GUI-session command using the shared
signing lock, not a temporary LaunchAgent. Wait for build completion before install.
Its status JSON records the exit result, and install verifies identity, paid team,
phone/profile expiry, signature, icon absence and extension resource hashes.
`finish` has no background job to remove. Do not add Allow in Background items.
Use the current trusted Mac address 192.168.1.198 from the shared access runbook.

Pause only the idle existing monthly scheduler before synchronization. After
physical acceptance, approve the delivered Tango baseline with the existing
Reader Extensions `scripts/refresh.py approve --config
build/installed-refresh/config/tango.json`, verify its monthly renewal, and resume
the same scheduler. The monthly runner needs only the staged payload, not Node or
a Video Platform checkout on the Mac. Preserve native login and Safari website
data; do not uninstall the host or clear cookies.

Porntrex is deferred to its own second pass. Both online providers will remain
extensions of Tango; five standalone apps await future online authentication work.

The physical check loaded the first 20 uploads in about one second and completed
all 406 rows incrementally. The supplied upload played at 1080×1920; shared
timeline seek, mute and Back to scrollY 400 passed. Document-start takeover must
create its head/body explicitly, as the old extension did. WebKit tests now cover
that early startup as well as the shared UI and local provider boundaries.
Physical finger/momentum feel remains for the user to compare.

Renewal passed with all three profiles expiring October 2, 2027. Its first attempt
hit the existing Xcode provisioning-cache replacement race; an unchanged retry
succeeded. The existing monthly job is restored, idle and exits 0, with no new
background item. See `xvid-video-platform-verification.json`; the shared
environment recovery copy includes that evidence and the build 12 project script.

Build 13 adjusts Xvid display names only. Bracketed text containing the upload's
`YYYY-MM-DD HHMMSS` timestamp becomes its list/player label without brackets;
titles without that timestamp keep their full text. Upload IDs, progress and
navigation URLs retain their existing meanings. The shared provider parser
applies this rule once for both the list and player.
