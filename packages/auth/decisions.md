# Auth Decisions

## Tango token lifetimes and refresh cadence

`src/providers/tango/constants.ts` holds the external lifetimes:
`TANGO_SESSION_TOKEN_TTL_S = 3600` (access token, `Tango-ST`) and
`TANGO_STREAM_TOKEN_TTL_S = 10` (stream tokens `tt`/`ttu`/`tte`). Each refresh
cadence is half its TTL: stream tokens every 5 seconds, the session every 30
minutes. The stream-token cadence runs from the start of each refresh, so a slow
answer does not delay the next one; the request is abandoned after 4 seconds
(one cycle less a second, queue wait included) and a failed refresh is retried
after 1 second, because the token it replaces expires one cycle later. A session refresh also returns a replacement refresh token
(`Tango-RT`) when Tango issues one; a 401 or 403 from the refresh falls back to
a browser login.

The tokens are written to
`~/.local/share/video-services/session/<account email>.json`, which `readTokens()` in
`packages/shared` reads on every call.

## Persist a rotated refresh token before anything else

A session refresh consumes the previous refresh token, so its replacement is
saved before the stream tokens are requested; a stream-token failure or an
interruption cannot lose it (`test/session-refresh.test.mjs`).

## Auth queue: pass the full response, not just the body

The auth request queue (one request at a time, one second apart) resolves with
the full `Response`, not parsed JSON. Callers read `set-cookie` headers to
extract tokens; a body-only result would lose them.
