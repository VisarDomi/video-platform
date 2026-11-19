# simulator

Simulated sites for end-to-end tests and demos of the capture and upload
pipeline:

- **Three live sites** serve prepared footage as live HLS, each with the
  protocol behaviour and quirks a real capture client must handle: token
  expiry, outages, sequence gaps and restarts, CDN edge failover, quality
  ladders, stream ends and damaged segments.
- **A file host** serves prepared files through signed, short-lived links on a
  second host, with byte ranges and stalled or cut transfers.
- **Two upload destinations**: `form-host`, driven through its web pages by a
  browser, and `api-host`, an API with tokens and resumable uploads. Both
  process, publish, refuse, rename and remove videos the way the pipeline must
  survive.

A scenario file scripts when channels go live and which faults happen when.
Everything the simulator publishes and every response it gives goes into an
append-only ground-truth log. `simulator check` compares a recording folder
with that log: what the site published, what the client missed, what the site
skipped, and which bytes differ.

No dependencies beyond Node 22 and the `ffmpeg`/`ffprobe` command-line tools.

## Quick start

```sh
npm run build
# 1. Prepare media once (any folder of videos; the first 10 minutes of each).
node dist/cli.js prep --input ~/Videos/matches --out ~/.cache/sim-media --minutes 10
# 2. Serve the demo scenario.
node dist/cli.js serve --scenario scenarios/demo.json --media ~/.cache/sim-media --state ~/.local/state/sim
# {"event":"listening","ts-live":"http://127.0.0.1:18081",...,"truthFile":".../truth.jsonl",...}
curl -s http://127.0.0.1:18080/state | jq '.sites[].channels[]? | {id, online, session}'
# Any HLS player can watch a channel, e.g. an unobfuscated fmp4-live one:
curl -s http://127.0.0.1:18083/api/channels/502/stream | jq -r '.stream.masterUrls.a' | xargs ffplay
# 3. Check what a client recorded against what was published.
node dist/cli.js check --truth ~/.local/state/sim --recording <folder> --site fmp4-live --channel 501
```

| Port | Name | What |
|---|---|---|
| 18080 | `control` | the control API |
| 18081 | `ts-live` | live site: account-gated HLS over MPEG-TS |
| 18082 | `ladder-live` | live site: handshake channel and a quality ladder |
| 18083 | `fmp4-live` | live site: fMP4 from several edges, obfuscated playlists |
| 18084 | `file-host` | file pages, albums, link API |
| 18087 | `file-host-cdn` | the file host's download host (signed links) |
| 18085 | `form-host` | browser-driven upload destination |
| 18086 | `api-host` | API upload destination |

`serve` options: `--host` (default `127.0.0.1`), `--ports name=port,...` (the
names above; `0` = any free port), `--tls-cert`/`--tls-key` (PEM files; every
port then speaks HTTPS), `--clock real|manual`, `--state <dir>`,
`--truth-max-bytes 100M`, `--truth-max-age 1h` and `--truth-keep N` (log
rotation, below).

## Design

```
media/     prep: input videos -> segment cache + manifest.json; byte-level TS/fMP4 edits
scenario/  the scenario schema and its strict validator
engine/    ChannelModel: when a channel is live and what each edge lists, at any instant
           Publisher: writes what appears on each edge into the ground-truth log
sites/     ts-live, ladder-live, fmp4-live: HTTP APIs and HLS on top of the engine
           file-host; form-host and api-host on a shared video catalogue (videos.ts)
truth/     the log writer (with rotation) and TruthIndex, the query side for checkers
check/     the recording checker
http/      routing, cookies, multipart bodies, streamed and ranged file replies
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
each site's state (token families, provisioning requests, follows; the
destinations' sessions, uploads and videos) are written with write-temp, fsync,
rename, fsync-directory before any response that depends on them. Uploaded
media lives under `<state>/blobs/<site>/` (chunks written the same way,
resumable uploads appended and fsynced before the offset is reported); without
`--state` it goes to a temporary directory removed on close. The ground-truth log is opened `O_APPEND`, one `write` per
record, fdatasync'd within a second; a torn last line after a power cut is
skipped by the reader. Restarting `serve` with the same scenario file resumes
the persisted state (including a scenario switched in through the control API);
a different file starts over (the sites' documents and blobs are cleared; the
truth log keeps growing).

**Videos are facts plus a timeline.** A destination stores only what happened
(who uploaded which bytes when, with which metadata, what probing found); a
video's state at any instant (uploading, processing, ready, failed, removed,
rejected) is computed from those facts, the scenario rules and the clock. A
clock jump or a restart never leaves a video stuck in a stale state.

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

## The live sites

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

## The file host

A file-sharing site, not live. Files are prepared media from the cache: the
mezzanine of a source (the prepared original) or a lower rung (`rung-<h>`, a
smaller copy of the same source).

| Endpoint | Behaviour |
|---|---|
| `GET /f/<id>` | File page: `h1.file-name`, `.file-size[data-bytes]`, `video#player[poster][data-poster]`, `og:image`, a download button `a#download[href="/download/<id>"]`, and `window.fileContext = {id, name, size, api, link}`. `404` before the file's `at` and after a `fileRemoved` fault. |
| `GET /a/<album>?page=N` | Album listing for a browser extension: `h1.album-title`, `.count[data-count]`, `#gallery .item[data-file-id]` cards with `a[href^="/f/"]`, `img.thumb`, `.name`, `.size[data-bytes]`, `.date`; `a[rel=next]`/`a[rel=prev]`; `404` past the last page. |
| `GET /api/file/<id>` | `{id, name, size, type, album, page, uploadedAt}` |
| `POST /api/link` | Body `{id}` (JSON or form). `{url, expires, ttlS, name, size}`: a signed URL on the download host, valid `signatureTtlS` (60). With `requireReferer`, the `Referer` must be a file page (`403` otherwise). |
| `GET /download/<id>` | The button: `302` to a fresh signed URL. |
| `GET\|HEAD <cdn>/dl/<id>/<name>?exp=&sig=[&hop=]` | The bytes. Forged signature: `403 Invalid signature`; expired: `403 Link expired`. With `redirectHops: n` the first n requests redirect back and forth between the download host and the site host (`hop=1, 2, ...`); an `offsiteRedirect` fault sends one hop to a host no allow-list may follow (default `http://169.254.169.254/latest/meta-data/`). `Range` (one range; `bytes=a-b`, `a-`, `-n`), `If-Range` (another validator gets the whole file), `ETag`, `Last-Modified`, `Accept-Ranges`, `Content-Disposition: attachment`; `416` past the end. |

Faults (`at`/`until` in seconds from the epoch): `transferStall` (`mode`
`slow` = throttle to `bytesPerSecond`, `stall` = stop after `afterBytes` and
hold the connection `stallS` or until the client gives up, `cut` = close the
connection after `afterBytes`; optional `file`, `ratio`), `etagChange` (`at`,
optional `file`: the validator changes, so a resume must start over),
`offsiteRedirect`, `fileRemoved` (`at`, `file`), `apiStatus` (`status` or
`"malformed"` or `"reset"`, optional `api`: `page`, `file`, `link`, `album`,
`download`).

What a `FileHost` plug-in needs: `canonicalPage` = `<site>/f/<id>`; `resolve`
= `POST /api/link` (or follow `/download/<id>`), filename from the response;
`isAllowedHost` = the site host and the download host (both ports), never
anything else; `jobKey` from the page path.

## The upload destinations

Both keep their state (sessions, tokens, uploads, videos) in `--state`. Video
ids are the remote ids a destination plug-in captures: numeric on form-host,
11 characters on api-host. A video's processing ends `processingS` (default
60) after its creation boundary, then it is published (`ready`) or `failed`
(unreadable media, a duration limit, a rule); removals come from rules or the
control API. Renditions follow the source size: a full-HD tier (1080p) only
when the source is at least 1920 wide; 720p, 480p and 360p when the source
reaches the tier's width or height; 360p always. Each tier's picture fits a
16:9 box of its height (a portrait 1080x1920 source tops out at 406x720). A
tier with the source's own size serves the upload itself; others are scaled
once on first request (nice'd ffmpeg). The truth log records each video's
schedule when it is created (see the log's events).

### form-host: a browser-driven destination

The pages carry the DOM a browser automation works against, and the site's own
scripts post every form (verified in a real browser: consent, login, upload,
category popup, submit).

| Page | Behaviour |
|---|---|
| any page without the `consent` cookie | `#overlay` with exactly one `#okButton` ("Accept and continue"), a form posting to `/consent/` (sets `consent=1` for 7 days). |
| `GET /login/` | One visible `form#login_form`: `username`, a single password input `name="pass"`, a hidden `csrf_token` bound to the `sid` cookie, a styled-hidden `remember_me` box; a hidden `#reset_password_form` (inputs to ignore). |
| `POST /login/` | Wrong CSRF token: `403`. Wrong password: `200` with `.generic-error`. Success: `302 /`, a new `sid`; every other session of the account is signed out; `remember_me=1` also sets `remember`. Signed-in pages show `a.user-link` "Hello, <name>". |
| `GET /upload-video/` | **The session check.** Signed in: `200` with `input[type=file][name=content]`. Signed out: `302 /login/` (`signedOutUpload`: or `302 /`, or `200` with `name="pass"`). |
| upload form | `#upload_form` with `upload_token`, radio `#edit_video_upload_option_file`, `window.pageContext.upload_chunk_size` (`chunkSize`, default and maximum 4 MiB), `.form-upload .progressbar .text` (whole percent), `.form-upload .generic-error`. |
| `POST /upload-video/?mode=async&action=upload_file` | Multipart `content` + `index` + `upload_token`: `{status:"success", index, received}`. Retrying an index replaces it. Over 4 MiB: `413`. Signed out: `302 /login/`. |
| `POST /upload-video/?mode=async&action=finish_upload` | Media-free: `upload_token`, `total`, `filesize`. Assembles and probes: `{status:"success", file_token}` or `{status:"failure", errors:[{code:"missing_chunks", indexes}]}`. Takes `assemblyDelayMs`. |
| metadata form | `#edit_video_form`: `#edit_video_title` (max `titleMax`, 300), `textarea#edit_video_description`, `#edit_video_tags` (comma list), `#edit_video_categories` opening `.categories-popup` of hidden checkboxes `#category_<id>` with `label[for]`; any click outside closes it and leaves hidden `input[name="category_ids[]"]`; `is_private` radios. Posting it (`action=add_video`, `csrf_token`, `file_token`) **creates the video** (the creation boundary); the reply is a success page without the id. A refused word answers the form again with `.generic-error` "Sorry, '<word>' is not allowed here." and creates nothing. |
| `GET /my/videos/[?is_private=1]` | `h2` "My Videos (N)" counting videos as of `listTotalsLagS` (60) ago; tabs `a[data-parameters="is_private:0"]` "Public (N)" and `is_private:1` "Private (M)" (totals include processing rows and still count a removed video for `removalLagS`, 60); `#list_videos_my_uploaded_videos` with rows `.item[data-item-id]`, newest first, `pageSize` (30) a page. Published rows: `p.inf a[href="/video/<id>/<slug>/"]`; processing rows: class `processing`, `.line-processing`, an empty href; failed rows: class `error`, `.line-error`, no link; `.line-limited` "Limited visibility due to : <reason>". |
| `GET /my/videos/?mode=async&function=get_block&block_id=list_videos_my_uploaded_videos&sort_by=&from_my_videos=N[&is_private=1]` | Page N of the block alone. **Past the last page: `404`** (the completeness proof); a `listStatus` fault answers `404` (or 5xx) for pages that exist. |
| `GET /edit-video/<id>/` | Published videos of the signed-in owner: the stored `#edit_video_title`, description, tags, hidden `category_ids[]`, notices (`.notice`: "Sorry, 'X' is not allowed here." for a `replace-notice` word, "Limited visibility due to : <reason>") and `a.video-link[href="<origin>/video/<id>/<slug>/"]`. **`404` while processing**, when failed and after removal. |
| `GET /video/<id>/<slug>/` | Published: `var flashvars = {video_url, video_url_text, video_alt_url, video_alt_url_text, video_alt_url2, ...}` lowest tier first ("360p", "480p", "720p HD", "1080p FHD") and `a.download[href*="/get_file/"]`. Another slug: `301` to the right one. **The slugless `/video/<id>/` is always `404`.** |
| `GET /get_file/<id>/<height>/<name>/` | The tier's MP4 with ranges. A `tierStatus` fault fails one tier while the others work. |

Sessions: the `sid` cookie rotates on a signed-in page view once the session is
`rotateSessionS` (600) old; the old id keeps working `rotationGraceS` (30). A
`remember` cookie (when the session is gone) starts a new session and signs the
others out. A `logout` event signs an account (or everyone) out at `at`,
remember-me tokens too unless `revokeRemember: false`. A `cacheWindow` makes
GET pages under `path` come from a shared cache: the first request in the window
is stored (`x-cache-status: MISS`), later ones get that page (whoever it was
rendered for, cookies stripped) with `age` and `x-cache-status: HIT`. A session
check must call such a page inconclusive.

Words: `bannedWords` with `action` `refuse` (the metadata form is refused),
`replace` (stored silently with `replacement`, default asterisks; the slug
follows the stored title) or `replace-notice` (replaced, plus a notice on the
edit page); `visibilityRules` (`word`, `reason`) add the limited-visibility
label.

### api-host: an API destination

| Request | Behaviour |
|---|---|
| `POST /oauth/token` | Form or JSON; client by `client_id`/`client_secret` or HTTP Basic (`clients`, default `sim-client`/`sim-secret`). `grant_type=password` (`username`, `password`): a new token family, `{access_token, token_type:"Bearer", expires_in, refresh_token, scope}`. `grant_type=refresh_token`: a new access token; with `rotateRefreshTokens` also a new refresh token, and presenting a spent one revokes the family. Errors: `401 invalid_client`, `400 invalid_grant` (wrong password, unknown, revoked or reused token), `400 unsupported_grant_type`. |
| `POST /oauth/revoke` | `token=`: revokes its family. |
| `GET /oauth/tokeninfo?access_token=` | `{sub, exp, expires_in, scope}` or `400 invalid_token`. |
| any `/v1`, `/upload/v1` call | `Authorization: Bearer`. Missing, expired or revoked: `401` with `WWW-Authenticate: Bearer error="invalid_token"` and `error.errors[0].reason` `invalid_token`, `expired_token` or `revoked_token` (a confirmed sign-out); `apiStatus` faults give 5xx/429 (inconclusive). Every call costs quota units (below). |
| `GET /v1/me`, `GET /v1/limits` | The account; `{maxBytes, minDurationS, maxDurationS, titleMax, descriptionMax, tagsMax, chunkGranularity, quota:{dailyUnits, used, resetsAt}}` (free). |
| `POST /upload/v1/videos?uploadType=resumable` | Headers `X-Upload-Content-Length` (required), `X-Upload-Content-Type`; body `{snippet:{title, description, tags, categoryId}, status:{privacyStatus}, clientRef?}` (or an `Idempotency-Key` header). **Creates the video** (creation boundary `api_create`): `200` with the video, `uploadUrl`, `Location` and `X-Video-Id`. The same `clientRef` again returns the same video and session (`X-Idempotent-Replay: true`). `422` with `errors[{reason:"bannedTerm", field, term}]`; `400` `invalidTitle`, `fileTooLarge`, `missingContentLength`. |
| `PUT /upload/v1/sessions/<id>` | `Content-Range: bytes a-b/total` with the bytes (or the whole body without the header): `308` with `Range: bytes=0-<last>` until complete, then `201` with the video (`200` afterwards). `Content-Range: bytes */total` asks for the offset. A range starting before the offset is fine (only new bytes count); one starting after it is `400` with `expectedOffset`. Sessions expire after `uploadSessionTtlS` (a day): `404`, and the video fails (`uploadExpired`). `uploadFault` faults: `drop` (half the body is stored, the connection resets), `stall` (the same after `stallS`), `status`. |
| `GET /v1/videos/<id>` | `{id, clientRef, snippet, status:{uploadStatus: uploading\|processing\|ready\|failed\|rejected, privacyStatus, failureReason?, rejectionReason?}, processingDetails, upload:{received, total, complete}, fileDetails:{bytes, sha256, width, height, durationS}, renditions:[{height, width, label, url}], watchUrl}`. Deleted or removed: `404 videoNotFound`. |
| `PATCH /v1/videos/<id>` | `{snippet, status}`; `422` for banned terms. |
| `DELETE /v1/videos/<id>` | `204`; then `404`. |
| `GET /v1/videos?pageSize=&pageToken=&clientRef=&status=` | `{totalResults, items, nextPageToken?}`, newest first, a stable cursor; deleted and removed videos are left out, rejected ones stay. |
| `GET /watch/<id>`, `GET /media/<id>/<height>.mp4` | Public page and renditions (ranges) once ready. |

Quota: `quota: {dailyUnits, costs?}`; default costs `list` 1, `get` 1, `insert`
100, `update` 50, `delete` 50, `token`/`limits`/`upload` 0. Over the budget:
`403` with `errors[0]` `{reason: "quotaExceeded", domain: "usageLimits"}`. The
budget resets at midnight UTC of the simulated clock. `minDurationS` /
`maxDurationS` fail processing with `durationTooShort` / `durationTooLong`.
`revokeTokens` events revoke every family created before them (one account
with `account`).

### What a Destination plug-in needs

| Contract | form-host | api-host |
|---|---|---|
| `creationBoundary` | `metadata_submit` | `api_create` |
| `remoteIdPattern` | `/^\d+$/` | `/^[A-Za-z0-9_-]{11}$/` |
| `requiresBrowser` | yes (or HTTP with the same forms) | no |
| `session.check` | `GET /upload-video/` without following redirects: `200` + `name="content"` = signed in; `3xx` to `/` or `/login/`, or `200` + `name="pass"` = signed out; `age > 0` or `x-cache-status: HIT`, any other status or a network error = inconclusive | `GET /v1/me`: `200` signed in; `401` = signed out; 5xx, 429, resets = inconclusive |
| `session.maintain` | keep the rotated `sid` from `Set-Cookie` | refresh before `expires_in`; keep the rotated refresh token |
| `session.recover` | the `remember` cookie first, then a password login | refresh grant, then (if allowed) a password grant |
| `upload` | the page's chunk protocol (<= 4 MiB, same-index retries), finish, metadata form | create (with `clientRef` = the identity), PUT ranges, resume from `308`'s `Range` |
| `captureRemoteId` / `lookup` | scan `/my/videos/` tabs and pages until a page past the end answers `404` (twice, to beat transient 404s); match the identity in the row title | `GET /v1/videos?clientRef=` |
| `probe` | edit page `404` = look in the list (processing, failed or gone); the slug anchor then `/get_file/` tiers, highest first | `GET /v1/videos/<id>`: status and renditions; `404` = absent |
| `canonicalUrl` | the slug URL from the edit page or list; never `/video/<id>/` | `watchUrl` |
| `parseNotices` | "Sorry, '<word>' is not allowed here."; "Limited visibility due to : <reason>" | `422` `bannedTerm` errors |
| `limits` | `maxBytes` (10 GiB), `titleMax` (300); no minimum duration, but a removal rule (e.g. `shorterThanS: 120`) takes short uploads down later | `GET /v1/limits` |

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
    "fmp4-live":   { "edges": ["a","b","c"], "obfuscation": {"keys": {"k1": "secret"}, "keyId": "k1"}, "channels": [...] },
    "file-host":   { "files": [...], "albums": [...], "faults": [...], /* options */ },
    "form-host":   { "accounts": [...], "processingRules": [...], "removals": [...], "bannedWords": [...], "faults": [...] },
    "api-host":    { "accounts": [...], "quota": {...}, "removals": [...], "faults": [...] }
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

### File host and destinations

Their faults use `at`/`until` from the epoch (no sessions); window faults take
an optional `ratio`.

**file-host:** `files` (`id`, `name`, `source`? (default: picked by seed),
`from`? `"mezzanine"` (default) or `"rung-<h>"`, `album`?, `at`? when it
appears), `albums` (`id`, `title`), `signatureTtlS` (60), `redirectHops` (0),
`albumPageSize` (24), `cdnHostname` (host name put in download URLs; default
the bind address), `requireReferer`, `faults`: `transferStall`, `etagChange`,
`offsiteRedirect`, `fileRemoved`, `apiStatus` (see the file host).

**Video rules** (both destinations). A selector matches videos by any of `nth`
(the account's n-th video), `titleMatches` (a case-insensitive regex on the
submitted title), `shorterThanS` (media duration), `account`; none = all.

- `processingS`: the processing delay (default 60 s).
- `processingRules: [{...selector, processingS?, outcome?: "ready"|"failed", recoverAfterS?}]`:
  the first match sets the delay and the outcome; a failure with `recoverAfterS`
  publishes that long after it failed (an error row that later publishes).
- `removals: [{...selector, at?, afterS?, kind?, reason?}]`: with `at` only,
  matching videos that exist at `at` are removed then; with `afterS` only, each
  matching video `afterS` after its creation; with both, at the later of the
  two. api-host `kind`: `removed` (404, default) or `rejected` (status
  `rejected` with `reason`).

**form-host:** `accounts` (`username`, `password`, `displayName`?), `categories`
(`[{id, name}]`, default four tennis categories with ids 21-24), `chunkSize`,
`maxBytes`, `titleMax`, `pageSize`, the video rules, `bannedWords` (`word`,
`action`: `refuse`, `replace`, `replace-notice`; `replacement`?),
`visibilityRules` (`word`, `reason`), `rotateSessionS`, `rotationGraceS`,
`listTotalsLagS`, `removalLagS`, `assemblyDelayMs`, `signedOutUpload`
(`redirect-login`, `redirect-home`, `login-form`), `faults`:

| Type | Fields | Effect |
|---|---|---|
| `logout` | `at`, `account`?, `revokeRemember` (true) | Forced logout: sessions (and remember-me tokens) from before `at` stop working. |
| `cacheWindow` | `at`, `until`, `path` ("/") | GET pages under `path` come from a shared cache with `age` and `x-cache-status`. |
| `pageStatus` | `at`, `until`, `status` or `"reset"`, `path`? | Every request under `path` fails. |
| `chunkFault` | `at`, `until`, `mode`, `index`?, `status`?, `stallS`? | Chunk posts: `drop` (connection reset), `stall` (held `stallS`, 90, then reset), `login-redirect` (`302 /login/`), `non-json` (an HTML 200), `status`. Nothing is stored. |
| `listStatus` | `at`, `until`, `status` | The async list pages answer `status` (a transient 404). |
| `tierStatus` | `at`, `until`, `height`, `status` or `"reset"` | One tier's `/get_file/` fails. |

**api-host:** `accounts` (`username`, `password`), `clients` (`clientId`,
`clientSecret`), `accessTokenTtlS` (3600), `rotateRefreshTokens`, `maxBytes`,
`minDurationS`, `maxDurationS`, `titleMax` (100), `descriptionMax` (5000),
`tagsMax` (30), `pageSize` (25, at most 50), `uploadSessionTtlS` (86400), the
video rules, `bannedWords` (`word`), `quota` (`dailyUnits`, `costs`?), `faults`:
`revokeTokens` (`at`, `account`?), `apiStatus` (`status` or `"reset"`, `api`?:
`token`, `videos`, `upload`, `list`, `media`), `uploadFault` (`mode` `drop`,
`stall` or `status`; `status`?, `stallS`?).

## Ground-truth log

`<state>/truth.jsonl`, one JSON object per line:

| `type` | Written | Fields |
|---|---|---|
| `scenario` | at start and on every switch | `name`, `seed`, `hash`, `epochMs`, `reason` |
| `session` | when a session is first published | `site`, `channel`, `session`, `index`, `startMs`, `endMs`, `recordingId`, `source` |
| `publish` | when a segment appears on an edge, per variant | `site`, `channel`, `session`, `edge`, `tier` (the variant it is listed under), `rendition` (what is served, differs during a codec change), `k`, `seq`, `pdt`, `durationS`, `publishedAt`, `listedUntil`, `fetchableUntil`, `damage`, `sha256` and `bytes` of the exact bytes served, `srcSha256`, `srcIndex`, `loop` |
| `response` | every HTTP response, every port | `site`, `method`, `path` (no query), `status` (or `"reset"`), `kind` (master, media, segment, init, api, auth, control, page, redirect, download, upload), `bytes` (for streamed bodies: what was sent, with `planned` = the announced length), `sha256` for segments, and when known `channel`, `session`, `edge`, `tier`, `k`, `seq`, `mediaSequence`, `count`, `ended`, `stale`, `reason`, `range`, `file`, `video` |
| `event` | auth events and the hosts' facts | live sites: `login`, `login-failed`, `refresh`, `refresh-reused`, `stream-token`, `device-provisioned`, `device-acknowledged`. file-host: `file` (`file`, `name`, `bytes`, `sha256`, `source`, `from`, `availableFrom`, once per load), `link-issued`. form-host: `login` (`via` password or remember), `login-failed`, `logout`, `session-rotated`, `chunk` (`upload`, `index`, `bytes`, `retry`), `upload-assembled`, `metadata-refused`, `video-created` (`video`, `account`, `nth`, `title`, `storedTitle`, `bytes`, `sha256`, `facts`, `slug`, `processedAt`, `outcome`, `recoversAt`, `removedAt`, `tiers`), `video-removed`, `forced-logout`. api-host: `login`, `refresh`, `refresh-refused`, `revoked`, `video-created`, `upload-bytes`, `video-uploaded` (the schedule as above, plus `removalKind`, `failureReason`), `video-updated`, `video-deleted`, `video-removed`, `quota-exceeded`. |

`publishedAt`/`listedUntil`/`fetchableUntil` are whole milliseconds, rounded
up: the first instant the segment is listed, and the first it no longer is.
`listedUntil` ignores stale-cache faults (the `response` records show what
stale playlists actually listed). When a catch-up publishes many segments at
once (a big clock jump, or startup), only the first 500 per tick are hashed;
the rest have `sha256: null` and can be recomputed from `srcSha256`, `loop` and
`damage` with `MediaLibrary.segmentBytes`.

At startup, segments still within retention are logged as published; nothing
counts as available before the server started. The log grows by roughly
10-20 records per second with the demo scenario.

**Rotation.** With `--truth-max-bytes` (e.g. `100M`) or `--truth-max-age`
(simulated time since the file's first record, e.g. `1h`), the log fsyncs the
current file, renames it to `truth.<n>.jsonl` (`n` = 000001, 000002, ...),
fsyncs the directory and starts a new `truth.jsonl`; `--truth-keep N` deletes
all but the newest N rotated files. A new file starts with a `scenario` record
of reason `continue` (it starts no new period) and logs the live sessions
again, so a pruned set still reads on its own. `TruthIndex.fromFile(path)` and
`readTruthSet(path)` read the rotated files in order and then the current one
(`path` = the current file or its directory).

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

Each `Availability` has `seq`, `pdt`, `sha256`, `bytes`, `srcIndex`, `loop`,
`listed: {from, until}` and `fetchable: {from, until}`, clamped to the scenario
period it was published in.

## The checker

```sh
simulator check --truth <file|dir> --recording <dir> --site <id> --channel <id>
                [--media <cacheDir>] [--whole-session | --from <time> --to <time>] [--json <file>]
```

`--recording` is one recording folder as the capture client writes it
(`.active/`, `.pending/` or published): segment files
`<local number>_<recording identity>_<provider sequence>.ts` (fMP4 fragments
too), init files `init.mp4` / `init_<local>[_<n>].mp4`, and `playlist.m3u8`. A
UTC identity is stored without colons or fraction (`2026-06-01T12:00:00Z` ->
`2026-06-01T120000Z`); `normalizeRecordingId` does the same.

How it decides:

1. The identity in the file names picks the session(s) in the truth log.
2. Each file is matched to its session position `k` by provider sequence
   (numbering is per edge, so the sequence also names the edge) and SHA-256
   against every variant the site served for it. When several positions share
   a sequence (a numbering restart, overlapping edges), the one that continues
   the recording (after the previous file, on the same edge) wins.
3. Expected positions: from the first to the last recorded one by default;
   `--whole-session` everything the session published; `--from/--to` the
   positions listed in that time window.
4. A missing position is **missed by the client** if it was published on the
   edge the client was reading (the edges of the recorded neighbours), and
   **skipped by the site** if not; `availableOn` names the edges that did carry
   it (a failover could have saved it).
5. Two files on one position are **duplicates**; a file whose bytes match no
   served variant is a **byte mismatch**; a sequence the session never
   published is an **unknown file**. Hashes the log left out (catch-up) are
   recomputed with `--media`, otherwise such files are `unverified`.

Output: JSON on stdout (or the `--json` file), a summary on stderr; exit `0` =
OK, `1` = problems (misses, mismatches, duplicates, unknown files, playlist
entries without files), `2` = could not check.

```jsonc
{
  "ok": false, "verdict": "FAIL: the client missed 1 segment(s), 1 byte mismatch(es)",
  "site": "fmp4-live", "channel": "77",
  "recording": { "dir": "...", "recordingId": "2026-06-01T120000Z", "identities": ["..."], "segmentFiles": 30,
                 "initFiles": [{ "file": "init.mp4", "sha256": "...", "known": true }],
                 "playlist": { "present": true, "entries": 30, "ended": true, "discontinuities": 1, "missingFiles": [], "unreferencedFiles": [] } },
  "sessions": [{ "session": "...", "recordingId": "2026-06-01T12:00:00Z", "startMs": 0, "endMs": 0 }],
  "expected": { "mode": "recorded-span", "fromK": 2, "toK": 33, "positions": 32 },
  "counts": { "files": 30, "exact": 29, "byteMismatches": 1, "unverified": 0, "unknownFiles": 0, "duplicates": 1,
              "recordedPositions": 30, "missedByClient": 1, "skippedBySite": 1, "damagedAsServed": 0,
              "outsideExpected": { "before": 1, "after": 11 } },
  "missedByClient": [{ "k": 5, "pdt": "...", "edges": [{ "edge": "a", "seq": 505, "listed": { "from": 0, "until": 0 } }] }],
  "skippedBySite": [{ "k": 16, "pdt": "...", "clientEdges": ["a"], "availableOn": [{ "edge": "b", "seq": 36 }] }],
  "duplicates": [{ "k": 25, "files": ["23_..._525.ts", "24_..._45.ts"] }],
  "byteMismatches": [{ "file": "...", "k": 8, "edge": "a", "seq": 508, "bytes": 0, "sha256": "...",
                       "expected": [{ "tier": "fmp4", "sha256": "...", "bytes": 0, "damage": null }] }],
  "unknownFiles": [{ "file": "...", "reason": "..." }],
  "files": [{ "file": "...", "local": 0, "seq": 502, "bytes": 0, "sha256": "...", "k": 2, "edge": "a", "tier": "fmp4",
              "status": "exact", "duplicate": false, "damage": null }]
}
```

The summary:

```
fmp4-live/77 recording 2026-06-01T120000Z in /tmp/rec
  session: 3f9c...
  expected: positions 2..33 (32, recorded-span); 1 published before, 11 after
  files: 30 (29 exact, 1 byte mismatches, 0 unverified, 1 duplicates, 0 unknown)
  missed by the client: 1 (k 5)
  skipped by the site: 1 (k 16; 1 were on another edge)
  ...
verdict: FAIL: the client missed 1 segment(s), 1 byte mismatch(es), 1 duplicate(s)
```

In code: `checkRecording(TruthIndex.fromFile(dir), recordingDir, {site, channel, media?, expect?})`
and `formatReport(report)`.

## Control API

| Request | Effect |
|---|---|
| `GET /health` | `{ok: true}` |
| `GET /state` | Scenario, epoch, clock, media sources, URLs, and per channel: online, session, recording id, per-edge media sequence and window length, site details |
| `POST /scenario[?epoch=keep]` | Body: a scenario. Validated (`400` with `problems`), then switched to; the epoch is the scenario's, the current one with `?epoch=keep`, else now. |
| `POST /clock/advance` | `{ms}` or `{s}` |
| `POST /clock/set` | `{at}`: ISO time or epoch ms |
| `POST /clock/mode` | `{mode: "real"\|"manual"}`: manual freezes time until moved |
| `POST /sites/form-host/remove` | `{id, reason?}`: remove a video now |
| `POST /sites/form-host/logout` | `{account?, revokeRemember?}`: sign sessions out now |
| `POST /sites/api-host/remove` | `{id, reason?}`: remove a video now (404) |
| `POST /sites/api-host/revoke` | `{account?}`: revoke token families now |
| `POST /sites/<site>/videos` | the destination's videos and their states |

`/state` also lists the file host's files (`up`) and download host, form-host
accounts (`signedIn`) and videos (`state`, `url`), and api-host quota use,
token families and videos.

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

`npm test` builds and runs `node --test test/*.test.mjs` (about 20 s). Tests
generate a few seconds of test pattern with ffmpeg (never real footage) and use
the manual clock; servers bind to `127.0.0.1` on ephemeral ports. The checker's
tests record a channel the way the capture client does (playlist polling,
compound file names, an edge switch) and then damage the folder.
