# iOS Safari regression tests

## Extension port

`npm run tests:extension` builds the actual extension bundle and checks it against
controlled network/media boundaries in a disposable browser. Cases cover Home
ordering, same-window reinjection without duplicate requests, native stream URL
navigation, session handoff, three adjacent slots, mute, first-step block
confirmation without a provider write, and no takeover on an unmatched host.
The same production bundle also exercises midpoint continuity without scroll
writes, held touches, video/spacer landings, directional next/previous selection,
direction reversal, list boundaries, and finger-down/continued-momentum guards.
Settlement must complete directly in the scrollend event, without a timer or
animation-frame delay.
HLS decoding is mocked there; this does not establish iPhone playback or bfcache.

For native acceptance, enable only Stream Viewer's Safari extension (not its
userscript), sign in to Tango, and use the shared Gallery Reader repository's
`tests/ios/native-inspector.py --site stream` on the Mac's USB Web Inspector.
Check Home, open a stream, verify live HLS/adjacent slots, swipe vertically and
Back. Live follow/unfollow/block/download mutations are not needed for this port.
The shared iOS host has been built, signed and installed with all three extensions.

Native iPhone validation (iOS 26.6.1, September 8, 2026): one extension boot,
428px viewport at scale 1, live 720×1280 HLS decoding, three video slots, and a
working read-only download-list request. A Home sample had 128 live rows (28
followed). Home → stream added one history entry; browser Back reported persisted
true with the same boot/body, restored list and current-stream highlight.

### iOS 26 momentum cutoff (also affected the userscript)

Physical flick traces captured two midpoint transitions calling
`correctScroll → window.scrollBy(0, -760.875)` during momentum. Safari emitted
scrollend roughly 30ms later, abruptly stopping the flick. The initial extension
port had not changed the three-slot recycling, CSS or gesture implementation.

The extension preserves Tango's standards-mode document, while the userscript's
open/close produces quirks mode; native inspection confirmed that difference.
However, the user then reproduced the bad scrolling with the original userscript
on the same phone, ruling out an extension-only regression. A second native trace
of that userscript captured the same ±760.875px compensation during momentum,
followed by scrollend in approximately 36–70ms. The prior smooth
experience was on iOS 27. WebKit's [Safari 27 release notes](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/)
explicitly list a fix for programmatic scrolling interrupting iOS momentum.
Together these support an iOS-version interaction with the existing midpoint
scroll compensation.

The shared route now offsets the video stage when recycling rather than writing
the scroll position during momentum. It normalizes that offset directly on
scrollend, with no finger down. Finger release alone cannot normalize while
scrolling is still in progress; another scroll invalidates an earlier scrollend.
A video under the viewport midpoint stays selected and visually stationary.
If the midpoint lands in blank 10,000px space, it selects only the next entry when
scrolling down or previous entry when scrolling up, then centers it. A missing
neighbor keeps the current real entry. Distance through the spacer never skips
multiple entries.

Version 247 was built, signed and installed on the same iOS 26.6.1 phone. Native
inspection confirmed the extension boot and live HLS playback; the user tested
physical scrolling and reported liking the change very much. The post-fix trace
retrieval timed out and could not be recovered, so there is no instrumented
post-fix timing claim. That version retained the historical 100ms settling timer.

Version 248 removes that timer entirely; the user tested it on-phone and reported
that it looks good.
Midpoint recycling, directional spacer selection, and list-edge behavior remain
unchanged. Immediate settlement and the remaining touch/momentum guards are
covered by the controlled production-bundle regressions above. Video Platform
is not changed by this experiment.

The follow-up simplification shares midpoint detection between scrolling and
settlement and derives each adjacent target in one place. The touch/momentum
guards remain necessary even without a timer; the same behavior tests pass.

`tests/native-scroll.py` passively records physical gestures and transparently
wraps scrollBy for correlation, removing its observers after 45 seconds.
`tests/native-safari.py` provides the read-only native Home/stream/Back smoke.

The frozen behavior and target URL are defined in [`test.txt`](test.txt). The
automated suite exercises Tango Home and stream routes, including live-list
rendering, followed/recommended ordering, stream playback, adjacent preloading,
native-scroll scope presentation, midpoint selection, mute and block-confirmation
controls, vertical and horizontal gestures, stream refresh, URL history behavior,
and Back restoration.

The suite uses the tester's signed-in Tango account and the current live stream
list. The default commands treat provider data as read-only. Provider data can
change during a run, so the harness compares streamer identities and the app's
persisted order instead of assuming that live-list counts remain constant.

The default suite does not follow, unfollow, block, or change the download
list. Blocking is tested only through its first, non-destructive confirmation
step.

Deterministic edge cases run on the same phone against a test-only provider and
controlled media events. They exercise delayed enrichment, costreamer order,
fallback to the first fresh stream without querying stale costreamers,
highlight restoration without forced scrolling, audio-only removal, and
unavailable-media removal without mutating Tango.

Install the repository dependencies once:

```bash
npm install
```

Phone-harness setup is documented by
[`userscript-ios-test`](../../userscript-ios-test/README.md). Disable the normal
stream-viewer userscript **and Safari extension** because this test runner injects
the freshly built userscript itself. Sign in to Tango in Safari, and keep Safari unlocked and foregrounded
while a run is active.

## Running the tests

Before starting, show `https://example.com/` in the foreground Safari tab. The
runner refuses to claim an unrelated tab or inject over an active Stream Viewer
extension. A rejected initial preflight leaves the tab alone. A normal run ends by navigating the
controlled tab back to `https://example.com/`, including after a test failure.

Run the small Home and initial-stream smoke case first when validating a new
setup:

```bash
npm run tests:smoke
```

Run the complete safe suite with:

```bash
npm run tests
```

The same modes can be selected through the common test/site interface:

```bash
npm run tests -- --test smoke --site tango
npm run tests -- --test full --site tango
```

Run real-account action checks only when intentionally accepting their side
effects:

```bash
npm run tests:actions
```

`tests:actions` toggles follow and download-list membership and attempts to
restore their original states. It then follows the selected streamer if
necessary and performs a confirmed block. The block is deliberately
destructive and is not restored by the harness. A network failure can also
interrupt restoration of the nominally reversible actions. Do not use this
mode casually.

The test command:

- type-checks with `npx tsc --noEmit`;
- builds the current bundle with `npx vite build`, without incrementing the
  production version;
- injects the current bundle after real navigation and reload;
- navigates from Tango Home to a stream selected from the current live list;
- reports requirement-oriented groups as `PASS`, `FAIL`, or `SKIP`;
- leaves real-account actions skipped unless `tests:actions` was selected;
- returns Safari to `example.com`.

The smoke run covers Home, initial stream playback, mute, and block
confirmation. The full run also covers synthetic in-page gestures, stream
refresh, and committed Back navigation.

The automated suite can inspect page state after Back and invoke
`history.back()`. It cannot synthesize Safari's browser-chrome left-edge
gesture or inspect the interactive frozen-page preview while a finger is still
down. That preview must be checked manually on the phone.

If a run appears stuck, inspect the phone before stopping it. Live provider and
media operations have bounded waits, but Safari may be showing a permission,
login, or playback condition visible only on the device.
