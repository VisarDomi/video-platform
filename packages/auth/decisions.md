# Auth Decisions

## A core daemon, sites as plug-ins

The daemon (`src/main.ts`) loads the sites file and keeps every account of the
accounts file signed in on its site (`provider` in the accounts file, default: the
first site with auth). The site's plug-in implements the SDK's `SiteAuth`: sign-in,
renewals, the record the session is stored as, `classify(error)` and
`describeTokens(bag)`. The core (`AuthService`, `AuthContext`) owns the cadences'
loops, the hedging, the save queue and every re-login decision, taken from
`classify()`: `reauthenticate` and `verification` sign in again (a verification
request names the site in its warning), `needs-attention` stops automatic sign-ins,
anything else is an outage that keeps the session and retries. TsLive's code is in
`private/plugins/tslive/src/auth/` (its browser owner, Google sign-in and the phone's
token family).

## TsLive token lifetimes and refresh cadence

`private/plugins/tslive/src/auth/constants.ts` holds the external lifetimes:
`TSLIVE_SESSION_TOKEN_TTL_S = 3600` (access token, `TsLive-ST`) and
`TSLIVE_STREAM_TOKEN_TTL_S = 10` (stream tokens `tt`/`ttu`/`tte`). Each refresh
cadence is half its TTL: stream tokens every 5 seconds, the session every 30
minutes. The stream-token cadence runs from the start of each refresh, so a slow
answer does not delay the next one. A refresh unanswered after 1 second gets a
second, parallel request and the first answer wins (each bounded by 10 seconds);
a failed refresh is retried after 1 second. The usual failure is one request that
hangs while a fresh one answers in a fraction of a second; abandoning the slow
request instead would also cut off a merely slow API. Stream-token requests do
not go through the auth request queue, which runs one request at a time. A session refresh also returns a replacement refresh token
(`TsLive-RT`) when TsLive issues one; a 401 or 403 from the refresh falls back to
a browser login.

The tokens are written to
`~/.local/share/video-services/session/<account email>.json` through the core's
`CredentialStore` (`packages/shared`), which the site's consumers read on every call
for the account the sites file names (TsLive's capture and catalog through
`ctx.credentials`, with headers from `auth.headersFor`).

## Persist a rotated refresh token before anything else

A session refresh consumes the previous refresh token, so its replacement is
saved before the stream tokens are requested; a stream-token failure or an
interruption cannot lose it (`test/session-refresh.test.mjs`). "Saved" means
durable: the temporary file is fsynced before the rename and the directory after
it, so a power cut right after a rotation cannot leave only the consumed token.

The session and stream refresh loops share a per-account save queue. Each
atomic write and rename finishes before the next save starts, so concurrent
saves cannot share a temporary file or let an older snapshot replace a rotated
refresh token (`test/session-save.test.mjs`). A failed write is logged and
does not stop later saves.

## Auth queue: pass the full response, not just the body

The auth request queue (one request at a time, one second apart) resolves with
the full `Response`, not parsed JSON. Callers read `set-cookie` headers to
extract tokens; a body-only result would lose them.

## Login waiters cannot outlive their error handling

The TsLive response and Google popup waits are armed before navigation/clicks and
have rejection handlers immediately. If a trigger fails or browser cleanup closes
the context, the unused waiter cannot crash the daemon as an unhandled rejection.
Awaiting the popup still reports its original failure normally; the existing login
queue and maintenance retry own recovery. Tests run isolated child processes with
strict unhandled-rejection handling and fake browser objects, without real accounts.
