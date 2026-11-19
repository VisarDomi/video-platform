# simulator

Simulated live-streaming sites for end-to-end tests and demos of the capture
pipeline. Three sites serve prepared footage as live HLS, each with the
protocol behaviour and quirks a real capture client must handle: token expiry,
outages, sequence gaps and restarts, CDN edge failover, quality ladders, stream
ends and damaged segments. A scenario file scripts when channels go live and
which faults happen when. Everything the simulator publishes and every response
it gives goes into an append-only ground-truth log, so a checker can compute
exactly what a client could have fetched and compare it with what the client
kept.

No dependencies beyond Node 22 and the `ffmpeg`/`ffprobe` command-line tools.

## Quick start

```sh
npm run build
# 1. Prepare media once (any folder of videos; the first 10 minutes of each).
node dist/cli.js prep --input ~/Videos/matches --out ~/.cache/sim-media --minutes 10
# 2. Serve the demo scenario.
node dist/cli.js serve --scenario scenarios/demo.json --media ~/.cache/sim-media --state ~/.local/state/sim
# {"event":"listening","ts-live":"http://127.0.0.1:18081","ladder-live":"http://127.0.0.1:18082",
#  "fmp4-live":"http://127.0.0.1:18083","control":"http://127.0.0.1:18080","truthFile":".../truth.jsonl",...}
curl -s http://127.0.0.1:18080/state | jq '.sites[].channels[] | {id, online, session}'
# Any HLS player can watch a channel, e.g. an unobfuscated fmp4-live one:
curl -s http://127.0.0.1:18083/api/channels/502/stream | jq -r '.stream.masterUrls.a' | xargs ffplay
```

`serve` options: `--host` (default `127.0.0.1`), `--ports name=port,...` (names
`control`, `ts-live`, `ladder-live`, `fmp4-live`; defaults 18080-18083, `0` = any
free port), `--tls-cert`/`--tls-key` (PEM files; every port then speaks HTTPS),
`--clock real|manual`, `--state <dir>`.

## Design

```
media/     prep: input videos -> segment cache + manifest.json; byte-level TS/fMP4 edits
scenario/  the scenario schema and its strict validator
engine/    ChannelModel: when a channel is live and what each edge lists, at any instant
           Publisher: writes what appears on each edge into the ground-truth log
sites/     ts-live, ladder-live, fmp4-live: HTTP APIs and HLS on top of the engine
truth/     the log writer and TruthIndex, the query side for checkers
control.ts the control API; serve.ts starts everything; sim.ts holds the shared state
```

**Pure model.** The engine keeps no playback state. Which session is live,
which segments an edge lists, their sequence numbers, program date-times and
bytes are all functions of (scenario, seed, time). Two servers with the same
scenario agree, a restart continues the same timeline, and a test can ask about
any instant. The clock is injectable: real time by default, frozen and moved by
hand in tests or through the control API.

**Timeline.** A session plays the source's segments in order from a seeded
start position, looping. Segment `k` starts at the session start plus the
durations before it, is complete one duration later, and appears on an edge
`lagMs` after that. The live window is the newest `window` complete segments.
Program date-times are the segment's start (plus the edge's `pdtSkewMs`), so
they are continuous across loops. When the source loops, served bytes are
adjusted so the stream looks like one unbroken encoder: TS PTS/DTS/PCR and
continuity counters, fMP4 `tfdt`, `sidx` times and fragment sequence numbers all
continue from the pass before.

**Edges.** A channel may be served by several edges. Each has its own
numbering (seeded first sequence per session), lag and date-time skew, and its
own faults. ts-live and ladder-live serve a channel's first edge; fmp4-live
serves all of them.

**Durability.** With `--state`, the scenario in force, its epoch, the clock and
each site's auth state (token families, provisioning requests, follows) are
written with write-temp, fsync, rename, fsync-directory before any response that
depends on them. The ground-truth log is opened `O_APPEND`, one `write` per
record, fdatasync'd within a second; a torn last line after a power cut is
skipped by the reader. Restarting `serve` with the same scenario file resumes
the persisted state (including a scenario switched in through the control API);
a different file starts over.

## Media prep

`simulator prep --input <dir> --out <cacheDir> [--minutes N] [--max-height 1080]`

For each video in `<dir>` (mp4, mkv, webm, mov, m4v, ts, avi), in
`<cacheDir>/<source-id>/`:

| Directory | Contents |
|---|---|
| `work-mezzanine/` | H.264 (capped height and 30 fps, a keyframe every second, no scene-cut keyframes) + AAC 48 kHz stereo. The video is copied when the input already is H.264 within the caps with a keyframe about every second; the audio is always re-encoded (inputs may carry Opus). |
| `ts/` | ~1 s MPEG-TS segments, cut from the mezzanine without re-encoding |
| `fmp4/` | ~2 s fMP4 segments + `init.mp4` |
| `ladder-<h>p/` x3 | ~2 s TS segments of a three-rung ladder (source height, then 1080/720/480/360/240 below it) |
| `ts-alt/`, `fmp4-alt/` | the bottom rung cut like `ts/` and `fmp4/`: the target of resolution / codec-configuration changes |
| `damage/` | fixtures: TS segments cut to one frame, fMP4 fragments with a zero-size sample entry, a zero-byte file, a TS segment that changes resolution halfway |
| `manifest.json` | per rendition: segment files, durations, sizes, SHA-256, dimensions, codecs, bandwidth, init and track timescales, continuity-counter steps |

Renditions meant to switch index by index (`ts`/`ts-alt`, `fmp4`/`fmp4-alt`, the
ladder) cut at the same keyframes; prep fails loudly if they do not line up.
ffmpeg runs under `nice -n 19` with two threads. Each stage is built in a
`.partial` directory and renamed into place when complete, keyed on the input's
size, mtime and the options: a re-run skips finished stages, and an interrupted
one starts that stage over. Output is deterministic for a given ffmpeg build.

The server applies damage on the fly with the same functions that wrote the
fixtures, to whichever segment a damage window covers, so the damage matches
the segment's position and timestamps.

## The three sites

All three serve HLS with `#EXT-X-MEDIA-SEQUENCE`, a `#EXT-X-PROGRAM-DATE-TIME`
on every entry, and `#EXT-X-ENDLIST` once a stream ends. Each has simple HTML
pages (a list and a page per channel) for browser extensions to work against.

### ts-live: account-gated HLS over MPEG-TS

| Endpoint | Behaviour |
|---|---|
| `GET/POST /login` | Form login (`username`, `password`; JSON works too). Sets `refresh_token` (long-lived, HttpOnly), `device_id` and `session_token` (1 h). Starts a new token family. |
| `POST /api/session/refresh` | Cookies `refresh_token` + `device_id`, body `{accountId, sessionId}` (the refresh token's claims `sub`, `sid`; tokens are JWT-shaped). Rotates: the presented refresh token is spent, a new refresh and session token come back. Errors: `401 INVALID_TOKEN` (a spent token; with `reuseRevokesFamily` the family is revoked, `SESSION_REVOKED`), `401 TOKEN_EXPIRED`, `401 SESSION_NOT_FOUND`, `424 CHALLENGE_REQUIRED` (no device cookie), `400` (body does not match the token). |
| `GET /api/stream/token` | With `session_token`: sets `stream_token`, `stream_account`, `stream_expires` (epoch seconds), about 10 s; the body repeats them as `{token, accountId, expires}`. |
| `POST /api/device/provision` | With `session_token`, body `{requestId}`: a separate token family for a phone (`refreshToken`, `sessionToken`, `deviceId`, `sessionId`). Retrying the same request id returns the same credentials until they are used or acknowledged. |
| `POST /api/device/acknowledge` | `{requestId}`: closes the request (idempotent); a later provision with that id is `409`. |
| `POST /api/live/by-account-ids?pageSize=N` | Body `{accountIds: [...]}` (max 500), session token required. `{code:"OK", totalCount, records:[{stream:{accountId, id, masterUrl, status:"LIVE"\|"ENDED", kind}}]}`. No live account: exactly `{code:"OK", totalCount:0}` (no `records` key). With `extraRecords`, a record for an account nobody asked about is included. |
| `POST /api/profiles/batch` | JSON array of ids or names: `{<key>: {accountId, profile:{firstName, aliases:[{alias}]}}}`, current alias first. |
| `GET /api/followings?size=N`, `POST /api/follow` | `{following:[{accountId}]}`; follow takes a raw id body. |
| `GET /hls/<streamId>/master.m3u8` | Needs valid stream-token cookies, else `401`. Variants with `RESOLUTION`/`BANDWIDTH`/`CODECS`, lowest first, URIs ending in `&`. `mediaAsMaster` channels answer with the media playlist. |
| `GET /hls/<streamId>/<variant>/playlist.m3u8` | `401` when the stream token expired or was revoked; `404` once the stream ended (after the ENDLIST grace). ~6 x 1 s TS segments. |
| `GET /hls/<streamId>/<variant>/<k>.ts` | No token needed. |

Recording identity: the stream id (new per session).

### ladder-live: control-channel handshake and a quality ladder

| Endpoint | Behaviour |
|---|---|
| `GET /api/channels?page=N` | `{page, pageCount, pageSize, total, channel:[{id, name, started_at, paid}]}`; `paid != 0` = paid. `{channel: []}` is the authoritative "nobody live". |
| `POST /api/member` | Form `channel_id`: `{profile:{id, name}}`; any number answers, unknown ones with an empty profile. |
| `POST /api/control/open` | Form `channel_id`: `{status:0, url, token}`, or `{status:2, reason:"offline"}` / `{status:3, reason:"paid"}`. |
| `GET <url>/recv?after=N&wait=ms` | Long-poll (up to 25 s) for messages after index N: `{messages:[{index, message}]}`. `410` once closed and drained. |
| `POST <url>/send` | A message `{name, id, arguments}`. |

Messages: the server opens with `{name:"ready"}`. `get_stream_info`
(optionally `arguments.mode`) is answered by
`{name:"reply", id, arguments:{master, url?, playlists:[{url, mode, latency}]}}`.
`heartbeat` is answered with the same id. Unsolicited `viewers` messages arrive
in between, so clients must match replies by id. The channel ends with
`{name:"closed"}` after 60 s idle or when the stream ends.

Modes: `mode = quality x 10 + latency`, quality 5/4/3 = top/middle/bottom rung,
latency 0 = low, 1 = high, 2 = middle. Media playlists are
`/hls/stream/<channel>/<session>/<mode>/playlist.m3u8` (~4 x 2 s TS segments).
Once the stream ends, or while it is paid, the master and media playlists answer
`403` (or, with `endMaster: "empty"`, the master is a bare `#EXTM3U`). Old
sessions' URLs stay `403`. Recording identity: `started_at`. Scenario options:
`pageSize`, `endMaster`, `requireOrigin` (playlists need an `Origin`/`Referer`
from the site).

### fmp4-live: fMP4 from several edges, obfuscated playlists

| Endpoint | Behaviour |
|---|---|
| `GET /api/channels/status?ids=1,2` (or `ids[]=`) | Up to 100: `{channels:[{id, name, status, live, online, statusSince}]}`; status `public`, `private`, `group` or `off`. Only `public` + `live` is recordable; `online` is sometimes false while live. A body without `channels` means unavailable. |
| `GET /api/channels/<id>/stream` | `{channel:{...}, stream:{name, available, active, statusSince, edges, masterUrls:{edge: url}}}` |
| `GET /api/channels/by-name/<name>` | `{id, name, renamedTo?}`; old names resolve to the current one; `404` = no such channel. |
| `GET /edge/<e>/hls/<stream>/master.m3u8` | Variants `NAME="source"` and `NAME="<h>p"`, each with its own init map. |
| `GET /edge/<e>/hls/<stream>/<variant>/playlist.m3u8` | `#EXT-X-MAP`, ~3 x 2 s fragments, numbering and timing per edge. A codec change shows as a new `#EXT-X-MAP`. |
| `.../<variant>/init.mp4`, `.../<variant>/<k>.m4s` | Init segment and fragments. |

Private and group shows answer `403` on every playlist of every edge, and
`statusSince` (the recording identity) moves at each status change.

**Obfuscated playlists** (channels with `obfuscated: true`, keys under the
site's `obfuscation`). The master and media playlists carry
`#EXT-X-OBF-KEY:ID=<keyId>`. Each media entry is

```
#EXTINF:2.000,
#EXT-X-OBF-URI:<check>.<cipher>
/edge/a/hls/<stream>/fmp4/obfuscated.m4s      <- placeholder, 404
```

`check` is the first 8 hex digits of SHA-256(uri); `cipher` is
base64url(uri XOR keystream), the keystream being
SHA-256(`<secret>|<check>|0`) || SHA-256(`<secret>|<check>|1`) || ... A client
configured with the secret for the key id decodes each URI; the check tells a
wrong secret from a right one. `decodePlaylist(text, keys)` (exported) does the
whole playlist and reports `unknown-key` or `undecodable`. An `obfuscationKey`
site fault rotates the key id.

## Scenario format

JSON, validated on load; unknown keys, wrong types, unknown edges and faults a
site does not support are errors that name the path
(`scenario.sites.ts-live.channels[0].faults[1]: unknown key "stauts"`). See
`scenarios/demo.json`.

```jsonc
{
  "name": "demo",
  "seed": "demo-1",              // all "randomness" derives from it
  "epoch": null,                 // ISO time or epoch ms; null = when first loaded (then persisted)
  "segmentRetentionS": 120,      // how long a segment stays fetchable after it appears
  "sites": {
    "ts-live":     { "accounts": [...], "channels": [...], "faults": [...], /* options */ },
    "ladder-live": { "channels": [...], "faults": [...] },
    "fmp4-live":   { "edges": ["a","b","c"], "obfuscation": {"keys": {"k1": "secret"}, "keyId": "k1"}, "channels": [...] }
  }
}
```

Times are seconds from the epoch (or from each session start when a fault has
`"scope": "session"`), as numbers or strings like `"90s"`, `"15m"`, `"1h30m"`.

**Channel:** `id` (numeric for ladder-live and fmp4-live), `name`, `schedule`,
optional `source` (a media source id; default: picked by seed), `window`
(segments listed), `endlistS` (how long the final playlist with ENDLIST stays
up), `startPosition`, `edges` (`[{id, lagMs, pdtSkewMs, firstSequence}]`),
`renames` (`[{at, name}]`), `faults`, and per site `mediaAsMaster` (ts-live) or
`obfuscated` (fmp4-live).

**Schedule:** exactly one of `{"always": true}`,
`{"sessions": [{"start": 0, "end": 600}, {"start": 900}]}` (open end = forever), or
`{"cycle": {"periodS": 3600, "onlineS": 2400, "offsetS": 0}}`. Every session
gets a new identity.

**Channel faults** (all take optional `edge` and `scope`):

| Type | Fields | Effect |
|---|---|---|
| `playlistStatus` | `at`, `until`, `status`, `target` (`media` default, `master`, `any`), `ratio`? | Playlists answer `status` (401/403/404/410/429/5xx). `ratio` fails that share of seconds, deterministically. |
| `segmentStatus` | `at`, `until`, `status`, `ratio`? | Segment requests in the window answer `status`. |
| `skip` | `at`, `count` | A provider skip: `count` segments from `at` are never published. The window stalls, then restarts small after a hole in the numbering. |
| `restart` | `at`, `value` (0) | Numbering restarts at `value`; the window restarts from the first new segment. |
| `damage` | `at`, `until`, `kind`, `every` (1) | Segments starting in the window are served damaged: `single-frame`, `zero-byte`, `truncated` (half the bytes), `zero-size-sample` (fMP4). |
| `codecChange` | `at`, `until` | Segments starting in the window come from the next lower rendition (TS: a new resolution and SPS mid-stream, no tag; fMP4: a new `#EXT-X-MAP`). |
| `edgeOutage` | `at`, `until`, `status` or `"reset"` | Everything on the edge fails (`reset` cuts the connection). |
| `stalePlaylist` | `at`, `until`, `staleByS`? | A stale cache: the playlist frozen at `at`, or lagging `staleByS`. |
| `streamEnd` | `at` | The session ends early. |
| `showState` (fmp4-live) | `at`, `until`, `state` | `private` or `group`: status changes, playlists `403`. |
| `paid` (ladder-live) | `at`, `until` | Listed with `pay: 1`; playlists `403`. |

**Site faults** (`at` from the epoch): `apiStatus` (`at`, `until`, `status` or
`"malformed"` or `"empty"`, optional `api`: ts-live `live`/`profiles`/`followings`,
ladder-live `channels`/`member`/`control`, fmp4-live `status`/`stream`/`names`);
`tokenRevoke` (ts-live: stream tokens issued before `at` stop working);
`refreshStatus` (ts-live: `at`, `until`, `status`, `errorCode`?; with a code the
client must sign in again, without one the body is an HTML block page, an
outage); `obfuscationKey` (fmp4-live: `at`, `keyId`).

**Site options:** ts-live `accounts` (`username`, `password`, `accountId`,
`follows`?), `streamTokenTtlS` (10), `sessionTokenTtlS` (3600),
`refreshTokenTtlS` (30 days), `reuseRevokesFamily`, `extraRecords`.

## Ground-truth log

`<state>/truth.jsonl`, one JSON object per line:

| `type` | Written | Fields |
|---|---|---|
| `scenario` | at start and on every switch | `name`, `seed`, `hash`, `epochMs`, `reason` |
| `session` | when a session is first published | `site`, `channel`, `session`, `index`, `startMs`, `endMs`, `recordingId`, `source` |
| `publish` | when a segment appears on an edge, per variant | `site`, `channel`, `session`, `edge`, `tier` (the variant it is listed under), `rendition` (what is served, differs during a codec change), `k`, `seq`, `pdt`, `durationS`, `publishedAt`, `listedUntil`, `fetchableUntil`, `damage`, `sha256` and `bytes` of the exact bytes served, `srcSha256`, `srcIndex`, `loop` |
| `response` | every HTTP response, every port | `site`, `method`, `path` (no query), `status` (or `"reset"`), `kind` (master, media, segment, init, api, auth, control, page), `bytes`, `sha256` for segments, and when known `channel`, `session`, `edge`, `tier`, `k`, `seq`, `mediaSequence`, `count`, `ended`, `stale`, `reason` |
| `event` | auth events | `login`, `login-failed`, `refresh`, `refresh-reused`, `stream-token`, `device-provisioned`, `device-acknowledged` |

`publishedAt`/`listedUntil`/`fetchableUntil` are whole milliseconds, rounded
up: the first instant the segment is listed, and the first it no longer is.
`listedUntil` ignores stale-cache faults (the `response` records show what
stale playlists actually listed). When a catch-up publishes many segments at
once (a big clock jump, or startup), only the first 500 per tick are hashed;
the rest have `sha256: null` and can be recomputed from `srcSha256`, `loop` and
`damage` with `MediaLibrary.segmentBytes`.

At startup, segments still within retention are logged as published; nothing
counts as available before the server started. The log grows by roughly
10-20 records per second with the demo scenario; rotate or truncate it between
runs.

Reading it back:

```js
import { TruthIndex } from "simulator";
const truth = TruthIndex.fromFile("state/truth.jsonl");
truth.sessions({ site: "fmp4-live", channel: "501" });                   // identities
truth.available({ site: "fmp4-live", channel: "501", edge: "a", tier: "fmp4", from, to });
truth.listedAt({ site: "ts-live", channel: "acct-centre", tier: "ts" }, t);  // what a playlist showed at t
truth.fetchableAt({ ... }, t);                                           // what a request at t could get
truth.sequenceHoles({ site, channel, session, edge, tier });              // provider skips: not the client's fault
truth.responses({ site: "ts-live", kind: "media", status: 401 });
```

Each `Availability` has `seq`, `pdt`, `sha256`, `listed: {from, until}` and
`fetchable: {from, until}`, clamped to the scenario period it was published in.

## Control API

| Request | Effect |
|---|---|
| `GET /health` | `{ok: true}` |
| `GET /state` | Scenario, epoch, clock, media sources, URLs, and per channel: online, session, recording id, per-edge media sequence and window length, site details |
| `POST /scenario[?epoch=keep]` | Body: a scenario. Validated (`400` with `problems`), then switched to; the epoch is the scenario's, the current one with `?epoch=keep`, else now. |
| `POST /clock/advance` | `{ms}` or `{s}` |
| `POST /clock/set` | `{at}`: ISO time or epoch ms |
| `POST /clock/mode` | `{mode: "real"\|"manual"}`: manual freezes time until moved |

Each change is persisted (with `--state`) before it is acknowledged; explicit
clock moves publish to the truth log at once.

## Library use

`startSimulator(options)` (from `dist/serve.js`, re-exported by the package
entry) starts everything on ephemeral ports for tests:

```js
import { SimClock, startSimulator } from "simulator";
const sim = await startSimulator({ scenario, media: cacheDir, clock: new SimClock({ mode: "manual", at }), memoryTruth: true, autoPublish: false });
sim.urls["ts-live"]; sim.sim.clock.advance(11_000); sim.sim.publisher.tick(); sim.memory.records;
await sim.close();
```

## Tests

`npm test` builds and runs `node --test test/*.test.mjs` (about 15 s). Tests
generate a few seconds of test pattern with ffmpeg (never real footage) and use
the manual clock; servers bind to `127.0.0.1` on ephemeral ports.
