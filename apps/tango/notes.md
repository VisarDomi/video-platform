## what?
(extended description)

The list stays in the same order while browsing and returning to Home. Newly
discovered costreamers are appended to the end without duplicates. Refresh Home
to fetch a new list; a stream page keeps the tab's list. Blocked or unavailable
streams are removed from navigation. The stream overlay has mute, Follow
(❤️/🤍), the PC Tango download list (+/-) and Block, which asks once more (❓)
before blocking and unfollows first.

The page itself renews Tango's session and playback tokens; the app's Safari
login handoff, build and deploy are in [`apps/ios/PORT.md`](../ios/PORT.md).


## Supported providers

```
tango.me
```

## Manual maintenance

`scripts/tango-unblock-blocklist.mjs` is a standalone account-maintenance utility,
not part of the app or its tests. It reads the PC's existing Tango session
(`~/.local/share/video-services/session`) and uses the same blocklist endpoint as the
app and the server (`abregistrar/connection/v1/blocklist`, action `UNBLOCK`). It
defaults to a dry run. `--account <id> --execute` unblocks one account (e.g. after
testing Block); `--execute` alone unblocks **every** account on the blocklist, one per
second. It reports whether anything is still blocked afterwards.
