# Shared Decisions

## One source of truth for storage locations

`providerLayout.ts` defines every path the services share:
`<downloads root>/<provider>/<downloaded|edited|trash>` under `~/Videos/downloads`
(`VIDEO_DOWNLOADS_ROOT`), the services' data root `~/.local/share/video-services`
(`VIDEO_SERVICES_DATA_ROOT`), and the download lists
`<data root>/download-lists/<provider>.txt`. The server, downloader, and pipeline
take their provider folders and download-list paths from it.

## Tokens: diagnostic fields for 401 debugging

`readTokens()` reads the Tango session file on every call and returns, besides the
tokens, `readAtMs` (when it was read), `ttlAtReadSec` (seconds until `tte` expiry at
read time), and `tokenAgeMs` (milliseconds since the auth service wrote the file,
from its `lastWriteMs`). The downloader logs them with a playlist 401 to diagnose
token timing.

## Logging: journald priorities, one line per event, collapsed repeats

`createLogger(service)` writes `[service] level: message {details}` lines. When
stdout is the journald stream (`JOURNAL_STREAM` names it) a line has no colour
codes and no timestamp (journald stamps it) and starts with its sd-daemon priority
(`<3>` error, `<4>` warn, `<6>` info, `<7>` debug), so `journalctl -p warning`
lists only problems. In a terminal it keeps the timestamp and colours.
`journalPriority(level, fd)` gives the same prefix to services that print their
own lines (the pipeline's JSON events).

`LOG_LEVEL` (default `info`) selects the detail. The levels mean:

- **error**: a person has to act, or media or work was lost;
- **warn**: something handled that changed or risked the outcome;
- **info**: one line per lifecycle event (a recording started or ended, a
  recording published, a target list changed, a session lost or recovered);
- **debug**: routine mechanics (per-poll decisions, retries, refreshes, timings).

An identical line (level, message and details) repeated within a minute is logged
once; after the minute one line reports the number of repeats.

**Why:** The journal is read to answer "did anything go wrong, and with which
recording". Per-poll and per-retry lines bury that answer, and a loop that logs
on every iteration can write hundreds of thousands of lines an hour.
