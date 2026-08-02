# iOS Safari regression tests

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
stream-viewer userscript because the test runner injects the freshly built app
itself. Sign in to Tango in Safari, and keep Safari unlocked and foregrounded
while a run is active.

## Running the tests

Before starting, show `https://example.com/` in the foreground Safari tab. The
runner refuses to claim an unrelated tab. A normal run ends by navigating the
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
