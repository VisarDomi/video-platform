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
