# Tango tests

## Automated (PC, no real account)

```bash
npm run test:app:webkit
```

Runs `packages/app/test/providers.mjs` in Playwright WebKit against the built content
scripts (`node packages/app/scripts/build-content.mjs tango-live` first), with every
Tango, media and PC request answered by fixtures. For Tango it checks:

- Home: followed streams first, then recommendations, one entry per streamer, blocked
  streamers hidden;
- playback of the opened stream, no timeline for live streams;
- Follow: ❤️/🤍 toggles through `/follow/remove` and `/follow/add`, also after a swipe
  between streams (a swipe disables every overlay button until it settles; Follow and
  Block must come back);
- the +/- download-list button against the PC's Tango list;
- Block: the first tap asks (❓), the second posts `BLOCK` to
  `abregistrar/connection/v1/blocklist`, removes the streamer and moves on;
- co-streamers listed after the main stream, ended streams replaced by the next;
- takeover of tango.me at document start.

`packages/app/test/scroll-settlement.mjs` covers swipe settlement (touch and scrollend
boundaries, midpoint, next/previous). Server routes that unblock and follow a streamer
when it is added to the Tango download list are tested by `npm test -w server`.

## On the iPhone (real account)

The phone is cabled to the Mac and unlocked, with the Tango app in the foreground. The
scripts in `scripts/phone/` are evaluated in the app's page through ios-tools' WebKit
inspector on the Mac (`scripts/phone/run.sh <script>`). The inspector does not wait for
promises, so a check starts with one call and is read back with `state.js` until
`result.done` is true. Button presses use the real buttons' click handlers; physical
finger gestures are not exercised (the swipe is synthetic touch events, as in the
WebKit tests).

- `state.js`: page, current stream, Follow/Block button state, the first list rows, and
  the last check's result.
- `follow-test.js`: swipes to the next stream, then taps Follow twice. After each step
  it records whether the buttons are enabled and whether Tango's own following list
  contains the streamer. Ends in the starting state.
- `open-unfollowed.js` then `block-test.js`: opens a streamer you do not follow
  (blocking a followed one also unfollows it), taps Block twice, and checks that the
  stream left the list and that Tango's blocklist contains it. This is a real block:
  undo it with `node scripts/tango-unblock-blocklist.mjs --account <id> --execute`
  (the id is in `block-test.js`'s result as `target.id`).
