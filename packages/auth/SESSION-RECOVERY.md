# Tango PC session recovery

The PC session (`video-auth`) and the iPhone's Tango app session are independent.
Never copy a refresh token between them.

The PC reads its Google credentials from `~/.config/video-services/auth-accounts.json`
(`VIDEO_AUTH_ACCOUNTS_FILE` overrides it). The pipeline reads the upload sites'
credentials separately from `~/.config/video-services/upload-providers.json`
(`VIDEO_UPLOAD_PROVIDERS_FILE`); when they use the same Google account, changing
one file does not update the other. Both live outside the repository.

## Current ownership and API

The phone is the explorer; the PC pipeline is the backup engine. Each keeps its own
session. Ordinary phone renewal is native and independent of the PC.

The current web API base is `https://www.tango.me/api`. Refresh is
`POST /session-service/public/v2/session/web/refresh` with `{accountId, sessionId}`
from that same RT and the **complete issued cookie context**, including `Tango-DI`,
`Tango-DeviceId`, `Tango-SD`, ST and WST where applicable. Sending RT alone returned
424; retaining the issued device context passed consecutive direct renewals without
Google or a browser login. Preserve all replacement cookies and coherent RT/ST pairs
atomically. Device identifiers are retained while a valid rolling refresh session
needs them; their values and signed JWT expiries are never invented or regenerated.

The PC's own normal Tango client runs in its persistent `pc-<account hash>` Chromium
profile under `~/.local/share/video-services/tango-browser-profiles/`. This retains the
complete browser/device identity instead of reconstructing an incognito context at
every refresh. It alone rotates the PC RT. `video-auth` publishes its current ST and
10-second stream tokens to the existing private session file. Late stream responses
cannot overwrite a newer session generation; a failed durable write is reported and
later saves remain possible.

All ordinary PC authentication, including one-time phone setup, runs headful on the
existing Xvfb display `:111`, regardless of a parent service's desktop DISPLAY. Profiles
use the same GNOME credential-store policy across desktop/session restarts. They are
private, separate from the user's browser and from each other. No new service is added.

## One-time phone setup

`POST /api/tango/phone-session` requires `X-Phone-Key`, `{setup:true}` and a durable
`X-Phone-Request-ID`. It is an initial setup/API-migration adapter, not the phone's
routine renewal path. The setup browser waits for the complete device context, stops
its Tango pages, freezes the result, clears its local Tango data without logging out
at the provider, and closes. Google SSO remains private for a future explicit setup.
After handoff, only the phone consumes that session's RT. The PC recording profile is
never involved.

A repeated request ID retrieves the same frozen result after a lost response, even
when its ST has since expired: the phone adopts the valid refresh context and renews
it itself. Acknowledgment happens only after durable native adoption. Google initial
flows are serialized across PC/server processes by an account lease; provider outages
never become password-login loops. The operator `dist/phoneSession.js` calls this
existing authenticated service rather than opening another browser or reading the
PC recording credentials. Treat its output as secret and keep it outside logs/Git.

Safari import is the alternative initial setup: it copies the complete first-party
RT/ST/WST/SD/device context from the selected tab. The native app retains its account
and explorer state during temporary failures instead of describing a failed renewal
as a logout. Native renewal starts ahead of expiry, shares one in-flight owner, keeps
usable access flowing, and has a bounded background assertion for atomic adoption.

## Recovery checks

- `npm test -w auth` checks ownership, cookie/session generation, serialized initial
  sign-in, interrupted setup and the browser login flow. UI control tests use Xvfb.
- Before consuming a PC RT outside `video-auth`, stop that one owner and save every
  replacement before restarting it. Never consume a handed-off phone RT on the PC.
- Restarting the service reuses its persistent profile and valid session. It must not
  initiate another Google login solely because the process restarted.
- Recognized Google password/verification blocks retain the existing attention marker;
  do not clear it to repeat a rejected password.

## Current browser response and failures

Tango now returns Google login responses through
`https://www.tango.me/api/google-login/auth-code/v1/login`. The automation captures
successful first-party responses across the browser context (main page or popup),
accepting both current and legacy routes. A successful response is authoritative;
an optional Google Continue screen must not discard it. Timers are cleared on
completion, each flow submits credentials once, and private failure diagnostics
are under `~/.local/state/video-services/tango-login/`.

Recognized Google password/verification blocks create an account-specific
`*.attention.json` marker there and stop automatic password retries. Resolve the
human verification first; only then remove that exact account's marker and restart
the worker. Never clear a marker merely to repeat a rejected password.

Phone setup and the PC recording login have separate profiles and token families.
Sequential rotations of one shared family are not device isolation. Token values,
profiles and credential files stay outside Git and logs.

The corrected flow passed both an owner-visible desktop run and one controlled
Xvfb run. The original hidden failure reached Tango after Google but waited for
the obsolete hard-coded response URL; it was not reproduced after fixing capture.
