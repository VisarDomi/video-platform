# Tango Safari login handoff — September 12, 2026

The physical login handoff passed all four checks on September 12: native session
refresh, playback credentials, authenticated account access, and refresh after
removing short-lived cookies all returned **200**. The app retained the rotated
login in its existing Keychain entry. Do not repeat the old Mac replay test.

The login-only project has been folded into the shared provider-built app. See
[PORT.md](PORT.md) for current building, installation and app verification. This
file records the investigation and the one-time Safari handoff.

## Verified so far

- Reader Extensions' Stream Viewer was disabled by the user. Native inspection
  and a physical screenshot showed the original Tango website running in Safari.
  An existing logged-in session was initially available. The user later completed
  a fresh Google login after the copied session stopped refreshing.
- Copying only the page's account/session fields into an empty native HTTP client
  failed with 401. The same refresh call inside Safari returned 200.
- Inspecting cookies at `https://gateway.tango.me/` initially missed the refresh
  token. `Tango-RT` is restricted to the exact path
  `/session-service/public/v2/session/web/refresh`. Inspect that URL when checking
  its cookie; absence at the gateway root does not mean no refresh token exists.
- `Tango-RT` is Secure and HttpOnly. Its observed cookie deadline was seven days
  away, unlike the older PC auth notes' 90-day assumption. This is a cookie deadline,
  not a measured guarantee of server-side validity or indefinite login persistence.
- A Mac native HTTP client using credentials read from the phone's Safari session
  successfully refreshed (200), fetched playback credentials (200), and performed
  a read-only authenticated blocklist request (200). Dropping the native client's
  short-lived `Tango-ST`, `Tango-WST`, `tt`, `ttu`, and `tte` and refreshing again
  succeeded (200). Safari's cookies were not cleared or modified by this client.
- The current token failed against Video Platform's older
  `/proxycador/api/session/refresh` endpoint (401). The app must use the current
  `/session-service/public/v2/session/web/refresh` flow, not assume the old endpoint
  and token protocol are interchangeable.
- Importing `Tango-RT` alone also failed against v2 (`TOKEN_IS_UNEXPECTED`). Keep
  `Tango-DI` and `Tango-DeviceId` with it. The RT payload supplies `accountId` and
  `sessionId` for the v2 JSON body; these were compared in memory to the actual
  website fields. JWT decoding is extraction only; the server validates the token.

All credential values stayed in process memory during those inspections. Tool
output contains only status codes, field/cookie names and cookie attributes.
No follows/blocklist mutations, logout or PC token-file reads were used. However,
refresh is NOT a read-only operation: it rotates credentials. The Mac replay
discarded its replacement credentials when it ended, and the old source session
subsequently failed in both the app (`SESSION_NOT_FOUND`) and Safari (401).
This is consistent with the test consuming the rotating credential; exact server
revocation internals were not captured. Do not repeat that test on a live login.
The replay options have been removed from `tests/native-tango-auth.py`.

## Historical login-only iPhone prototype

Installed on the physical phone with the existing paid team `65U58U86DD`:

- App: **Tango**, `com.visar.Tango.paid`, no custom icon.
- Embedded Safari helper: **Tango Login**, `com.visar.Tango.paid.Login`.
- Shared Keychain group: `65U58U86DD.com.visar.Tango.paid`.
- Mac source/build: `/Users/visar/Developer/stream-viewer-auth-probe`.
- Keychain entry: service `TangoLogin`, account `session`; device-only protection.

The helper has no content scripts or ongoing refresh/background work. Its popup
reads the five named gateway authentication/device cookies after an explicit Import click and
passes them through native messaging directly to the shared Keychain. No clipboard,
URL credential payload, website localStorage credential copy, PC service, or
Reader Extensions dependency. The native handler must never log or echo messages.

Prototype’s verified physical flow (the current app opens the viewer after confirmation):

1. Open the real Tango website in Safari and sign in with Google if necessary.
2. Enable **Tango Login** in Safari's extensions menu and allow Tango site access.
3. Open its popup and tap **Import login into Tango**.
4. Close Tango's Safari tabs. Remove only Tango in Settings → Apps → Safari →
   Advanced → Website Data. This is local deletion, never the website's logout
   or server-side revocation. For this prototype, cleanup is a manual step;
   Safari does not provide the browser.browsingData API used by other browsers.
5. Return to the **Tango** app and tap **Safari data cleared — verify login**.
   Newly imported credentials are pending: opening/resuming the app does not
   refresh until this explicit confirmation. Its native URLSession checks refresh, playback
   credentials, a read-only authenticated request, then refresh without short
   session cookies. Successful refresh saves replacement long-lived cookies.
6. Disable Tango Login, kill/relaunch Tango and repeat the native verification.

Enabling a new Safari extension requires user interaction. The helper can stay
disabled after successful import, but needs to be available again if credentials
expire/revoke or the app needs a new login. It ships inside Tango so Reader
Extensions can be removed independently. An ordinary Safari Share action or
bookmarklet cannot read the HttpOnly refresh cookie. An entirely extension-free
interactive login handoff has not been demonstrated.

Build, signature, device provisioning, shared Keychain entitlement and no-icon
checks passed; installation and launch succeeded. Build 4 is installed, with
the confirmation gate described above. The first popup failed to find cookies
because Safari's default cookie store was empty (`persistent-1`) while the
active Tango tab used `persistent-2`. The corrected helper resolves the active
tab ID to `cookies.getAllCookieStores().tabIds` and supplies that storeId for
every cookie read. Actual popup inspection confirmed that this found Tango-RT.
Running that corrected import inside the real popup returned native `ok:true`;
the app read the shared Keychain entry. Three regression tests cover profile
selection, refusing an unrelated store, and rejecting a non-Tango active tab.

The subsequent fresh Google login, import and local Safari cleanup passed on the
physical iPhone. `Documents/auth-probe-status.json` recorded ready=true and all
four HTTP 200 checks at epoch 1789250030.4360061. This supersedes the earlier
401 result. That proof establishes native login ownership, not media playback;
see PORT.md for the separate full-app checks.

## Reproduce without exposing credentials

Start with [shared Mac access](/home/visar/Documents/environment/mac-access.md).
Use that document's SSH host verification options; Mac Ethernet is `.198`.
The existing Mac Python is
`/Users/visar/Developer/gallery-reader-extension/inspector-venv/bin/python`.

`tests/native-tango-auth.py` enumerates only app/page IDs and hosts by default.
Use `--page-id ID --cookies` to print cookie metadata. `--wait-popup` waits up to
60 seconds for an open popup; Safari destroys that inspection target when the
popup closes. The old native-refresh replay options were removed because they
could consume the live refresh token and lose its replacement. Do not enable raw
Web Inspector/HTTP debug logging or dump cookie/Keychain/session objects.

The historical prototype used the now-retired `auth-probe` project. Current
sources are App/, Shared/ and Login/ with a required-provider builder; PORT.md
contains the supported commands. The temporary login-test build job was unloaded.

The app's `Documents/auth-probe-status.json` contains only completion status and
timestamps. It is safe to copy with devicectl for verification. Credentials live
only in Keychain; do not export them as diagnostic artifacts. Use a fresh native
inspector attachment after navigation and only one inspector at a time.

References: [Google's embedded-browser restrictions](https://developers.google.com/identity/protocols/oauth2/native-app#disallowed_useragent),
[Apple's Share/Action webpage preprocessing](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html).
