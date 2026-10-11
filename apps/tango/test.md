# Tango tests

## Automated (no real account)

```bash
python3 apps/ios/scripts/deploy.py tango-live sync
python3 apps/ios/scripts/deploy.py tango-live test
```

`test` runs `apps/ios/scripts/test.sh` on the Mac, which includes `Tests/TangoTests.swift`:
the list from Tango's gateway answers (followed streams first, then recommendations, one
entry per streamer, blocked and ended streams hidden), names from profiles, co-streamers,
and the session token's claims. Server routes that unblock and follow a streamer when it is
added to the Tango download list, and the PC login for the phone
(`/api/tango/phone-session`), are tested by `npm test -w server`.

The FC2 live and SC live extensions that Tango hosts are covered by
`npm run test:app:webkit` (their +/- download-list button, ⚠️ for an unreachable PC).

## On the iPhone (real account)

The app is native (`apps/ios/VideoApp/Tango.swift`, `TangoList.swift`), so checks are done
by hand on the phone, or in a simulator build (`SIMULATOR=1`) through NativeKit's test hooks
(ios-tools `native/scripts/sim`):

- the list opens at once with the last list and the position it had, also after the app
  was killed, and new streams join behind it;
- a stream plays at once, keeps playing when the phone locks, and a swipe moves to the next
  one; an ended stream leaves the list;
- Follow toggles ❤️/🤍; +/- edits the PC's Tango download list; Block asks once (❓) and
  then blocks, removes the streamer and moves on;
- sign-in: at home, "Log in from the PC" gets a new session from the PC
  (`/api/tango/phone-session`); away from home, the Safari handoff with the Tango Login
  extension.

A Block from a test is real: undo it with
`node apps/tango/scripts/tango-unblock-blocklist.mjs --account <id> --execute`.

The WebKit inspector scripts that drove the earlier web version (`scripts/phone/`) are in
Git history, before October 12, 2026.
