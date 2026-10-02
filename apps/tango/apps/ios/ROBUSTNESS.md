# September 22 network recovery pass — Tango build 11

Build 10's fresh-launch policy is retained: each new app process opens Home at
the top with a new list. State is held only for navigation within the session;
login remains in Keychain. No kill/stream restoration was reintroduced.

Native read requests, including the two recommendation-list POSTs and the batch
profile POST, retry transient network/server failures. Follow, Unfollow, Block,
refresh POST and optional PC commands are not blindly replayed by this policy.
A refresh response can rotate the cookie before its body disconnects; the catch
path persists that received replacement before another authentication attempt.
A server consuming a token without delivering its replacement can still require
login; client code cannot reconstruct a token it never received.

The HLS relay retries interrupted reads and cancels upstream work when WebKit
closes its loopback request. WebKit video recovery restarts network-error/stalled
playback without removing the streamer solely for a network error. Pause/mute
choices remain intact; the shared UI and hosted Xvid source are unchanged.
Transient authentication/network trouble is no longer shown as a login instruction.

Validation: `npm run tests:ios`, native typecheck and the offline Swift auth/HLS
fixture (command in PORT.md). Tests include rotating-token response-body loss,
read-only POST recovery, single-attempt mutations, loopback HLS/Range/HEAD,
network video recovery, fresh cold Home and session Back behavior.

## Physical validation

All provider builds were installed in place using their existing paid identities.
See `robustness-verification.json` for sanitized results. Cold-launch checks passed on the iPhone. A read queued with both Wi-Fi and cellular off completed with HTTP 200 after Wi-Fi returned, using the same pending request without a reload or manual retry.

The existing monthly runner successfully renewed every delivered provider build,
retaining the same app identities/data. The scheduler is resumed and its installed-app
scan exits successfully. No new background item or power-setting change was made.
