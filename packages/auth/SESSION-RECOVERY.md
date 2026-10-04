# Tango PC session recovery — September 26, 2026

PC and iPhone sessions are independent. Never copy a refresh token between them.
The PC reads Google credentials from `~/.config/video-services/auth-accounts.json`
(formerly `packages/auth/credentials.json`); XVideos reads the same Google account's
credentials separately from `~/.config/video-services/upload-providers.json` (formerly
also `packages/.env`). Both live outside the repository. Changing one does not update
the other.

The PC's old `/proxycador/api/session/refresh` request rejected a freshly acquired
PC session. The working request is POST
`/session-service/public/v2/session/web/refresh`, with the PC's own Tango-RT cookie
and JSON `{accountId, sessionId}` decoded from that same token. No phone credential
is involved. Persist replacement login/refresh credentials before requesting the
short-lived stream tokens; a downstream failure must not lose the rotated RT.

Validation:

- `npm run build --workspace=auth`
- `node --test packages/auth/test/session-refresh.test.mjs`
- Two sequential real PC refreshes: tokens rotated, persisted and reloaded;
  stream-token retrieval passed and authenticated Tango reads returned HTTP 200.
- Starting `video-auth` then refreshed the saved token successfully without Google
  login. The server's download-list profile lookup passed.
- XVideos' production browser profile reached the authenticated account dashboard.
  A separate fresh-profile Google login test hit "Too many failed attempts" and
  was stopped. That fresh-login path is not claimed verified; avoid repeated
  password submissions while Google is blocking them. No uploads were performed
  by these checks. The existing pipeline was resumed afterward.

Temporary diagnostic profiles were separate from `~/.config/chromium-agent`.
For future checks, pause competing token owners before consuming a rotating RT,
save every received replacement immediately, and restart the original services
when finished. A session-only dashboard check must not trigger fresh login when
Google is already rate-limiting attempts. The auth, pipeline, downloader and server
services were all active at completion.
