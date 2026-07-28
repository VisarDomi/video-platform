# iOS Safari regression tests

The repository contains its own remote debugger and phone test runner. The
frozen behavior and target URL are defined in [`test.txt`](test.txt). The
automated suite exercises Tango Home and stream routes, including live-list
rendering, followed/recommended ordering, stream playback, adjacent preloading,
mute and block-confirmation controls, vertical and horizontal gestures, stream
refresh, URL history behavior, and Back restoration.

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

One-time setup on a new development machine:

```bash
npm install
```

The debugger userscript currently connects to `192.168.1.197:36666`. After
cloning the repository to another machine, keep these values aligned:

- In `tests/ios/stream-viewer-debug.user.js`, change both `@connect` and
  `SERVER` to the laptop's LAN address. Change the port in `SERVER` if needed.
- If changing port `36666`, also change the bridge configuration or set
  `IOS_DEBUG_PORT`, and set the runner's `IOS_DEBUG_ORIGIN` to match.

The bridge configuration does not rewrite the checked-in debugger userscript.
Edit and reinstall the userscript when its server address changes.

Generate and trust the HTTPS certificate by following
[`certificate.md`](certificate.md). With `npm run tests:server` still running:

1. Open
   `https://192.168.1.197:36666/stream-viewer-debug.user.js`, or the
   corresponding URL configured above.
2. Install it in the iOS userscript manager.
3. Give the debugger permission to run on all tested websites.
4. Enable `stream-viewer-debug` and disable the normal `stream-viewer`
   userscript. The test runner injects the freshly built app itself.
5. Sign in to Tango in Safari.
6. Keep Safari unlocked and foregrounded. Temporarily set display auto-lock to
   **Never**, then restore the original setting after testing.

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
- starts the repository-local bridge when one is not already running;
- injects the current bundle after real navigation and reload;
- navigates from Tango Home to a stream selected from the current live list;
- reports requirement-oriented groups as `PASS`, `FAIL`, or `SKIP`;
- leaves real-account actions skipped unless `tests:actions` was selected;
- returns Safari to `example.com`.

The smoke run covers Home, initial stream playback, mute, and block
confirmation. The full run also covers synthetic in-page gestures, stream
refresh, and committed Back navigation.

The debugger can inspect page state after Back and can call `history.back()`.
It cannot synthesize Safari's browser-chrome left-edge gesture or inspect the
interactive frozen-page preview while a finger is still down. That preview
must be checked manually on the phone.

If a run appears stuck, inspect the phone before stopping it. Live provider and
media operations have bounded waits, but Safari may be showing a certificate,
permission, login, or playback condition visible only on the device.

### Configuration

- `IOS_DEBUG_ORIGIN` — local controller origin, default
  `https://127.0.0.1:36666`.
- `IOS_DEBUG_HOST` — address used for certificate generation and printed setup
  URLs.
- `IOS_DEBUG_PORT` — bridge port, default `36666`.
- `IOS_DEBUG_CERT` / `IOS_DEBUG_KEY` — custom HTTPS certificate paths.
- `IOS_DEBUG_CA` — custom public root CA path for `/api/cert`.
- `IOS_TEST_HOME_URL` — provider Home URL, default
  `https://www.tango.me/`.
- `IOS_TEST_COMMAND_TIMEOUT_MS` — remote-command timeout, default `90000`.
- `IOS_TEST_CONNECTION_TIMEOUT_MS` — initial debugger wait, default `120000`.
