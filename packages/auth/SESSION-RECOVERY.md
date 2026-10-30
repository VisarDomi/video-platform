# Tango PC session recovery

The PC session (`video-auth`) and the iPhone's Tango app session are independent.
Never copy a refresh token between them.

The PC reads its Google credentials from `~/.config/video-services/auth-accounts.json`
(`VIDEO_AUTH_ACCOUNTS_FILE` overrides it). The pipeline reads the upload sites'
credentials separately from `~/.config/video-services/upload-providers.json`
(`VIDEO_UPLOAD_PROVIDERS_FILE`); when they use the same Google account, changing
one file does not update the other. Both live outside the repository.

## Refresh request

The session refresh is `POST https://gateway.tango.me/session-service/public/v2/session/web/refresh`
with the PC's own `Tango-RT` cookie and the JSON body `{accountId, sessionId}`
decoded from that same token. No phone credential is involved. The response's
`Tango-ST` (and replacement `Tango-RT`) cookies are saved to
`~/.local/share/video-services/session/<account email>.json` before the
short-lived stream tokens are requested, so a downstream failure cannot lose the
rotated refresh token. A 401/403 or explicit HTTP 424 `CHALLENGE_REQUIRED` starts
the normal browser verification/login automation (headed Playwright Chromium on
the Xvfb display `:111`). Other 424/5xx failures never become password logins.
Startup validates a usable saved access token before consuming another refresh
token. Concurrent maintenance shares one owner, and recovery commits the new pair
before requesting stream tokens.

## Recovering

- Check the refresh path without the network:
  `npm run build -w auth && node --test packages/auth/test/session-refresh.test.mjs`.
- Before consuming the rotating refresh token from anything other than
  `video-auth`, stop the competing token owner
  (`systemctl --user stop video-auth`), save every replacement token it returns
  immediately, and restart the service when finished.
- `systemctl --user restart video-auth` resumes valid saved credentials without an
  unnecessary refresh; the normal maintenance loop renews ahead of expiry.
- When Google answers "Too many failed attempts", stop: repeated password
  submissions keep the block in place, and a session-only check must not trigger
  a fresh login.

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

For a phone-only session, use the existing protected `/api/tango/phone-session`
automation (`dist/phoneSession.js`); it never reads or writes the PC session file.
Import its fresh pair into the phone, then let the PC obtain its own separate
session. Sequential rotations of one shared family are not a device-isolation
strategy. Token values and credential files stay outside Git and logs.

The corrected flow passed both an owner-visible desktop run and one controlled
Xvfb run. The original hidden failure reached Tango after Google but waited for
the obsolete hard-coded response URL; it was not reproduced after fixing capture.
