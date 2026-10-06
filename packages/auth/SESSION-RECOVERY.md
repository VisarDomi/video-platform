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
rotated refresh token. A 401/403 from the refresh starts a browser login (a
headed Playwright Chromium on the Xvfb display `:111`).

## Recovering

- Check the refresh path without the network:
  `npm run build -w auth && node --test packages/auth/test/session-refresh.test.mjs`.
- Before consuming the rotating refresh token from anything other than
  `video-auth`, stop the competing token owner
  (`systemctl --user stop video-auth`), save every replacement token it returns
  immediately, and restart the service when finished.
- `systemctl --user restart video-auth` refreshes the saved token without a
  Google login when the token is still valid.
- When Google answers "Too many failed attempts", stop: repeated password
  submissions keep the block in place, and a session-only check must not trigger
  a fresh login.
