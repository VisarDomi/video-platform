# Durable video pipeline

This package owns the months-long per-recording processing queue: convert each
finalized edited recording, describe it, compose upload metadata, upload it to
the active provider and verify it online. It remains separate from Express; the
managed `video-pipeline` systemd user service runs its campaign worker.

## Campaign

The active generation is `production-v6` (`src/domain/productionVersion.ts`).
The campaign admits only `edited` recordings with an exact, current server
checkpoint (finalization report version 2, status `ready`) and orders them by
the timestamp in the folder name, oldest first, not by finalizer scan time.
Hidden directories and raw downloader folders are never admitted. Each
recording moves through convert → validate → describe → metadata → upload →
online verification.

- SQLite (`~/.local/share/video-services/pipeline/pipeline.sqlite`, override
  `VIDEO_PIPELINE_DB`; WAL, synchronous FULL, schema 12) holds recording state,
  transition events, leases, artifact hashes, description evidence, provenance,
  metadata, upload reservations/attempts, transmitted-byte accounting and remote
  identity. Recording IDs are the source folder names (datetime + alias).
- Provenance is resolved by the API server through `GET /api/{provider}/resolve`
  (Tango alias registry + live Tango API, FC2 numeric IDs, Stripchat username
  lookup; server `https://127.0.0.1:9999`, override `VIDEO_SERVER_URL`), with
  grouped review and reusable manual overrides. Identifiers the server cannot
  resolve upload with `Source: TODO LATER` (see `docs/upload-recovery.md`).
- Public titles are `<descriptive title> [<recording folder>]`, or
  `<descriptive title> [<recording folder> | part N]` for one shape of a split
  recording. Descriptions end with `Recorded:`, `Source:` and an optional
  `Alias:` line. Tags are only the provider tag (`tango`, `fc2`, `stripchat`)
  and `live`.
- Upload identity is the local ledger plus the captured provider video ID and
  the exact bracketed title suffix; the model-written title is never used to
  find a video.
- Uploads are budgeted per calendar month in `Europe/Tirane`
  (`VIDEO_PIPELINE_UPLOAD_TIMEZONE`): the campaign uses the limit stored by
  `campaign:configure` (default 600,000,000,000 bytes); `upload-one` uses
  `VIDEO_PIPELINE_MONTHLY_UPLOAD_BYTES` (same default).
- Network commands require `VIDEO_PIPELINE_NETWORK_UPLOADS=1`. The managed
  worker verifies due uploads inline.

## Conversion policy (resolution-policy-v5)

Every recording is converted; nothing is stream-copied and **no segment is
dropped**. Source folders and their playlists are never modified.

- **Shapes.** Segments are grouped by display aspect ratio (SAR applied, 1%
  tolerance; for fMP4 the last active `#EXT-X-MAP` owns a segment's size, MPEG-TS
  uses one whole-playlist keyframe scan). One shape is one upload (`full`).
  Several shapes are one upload each (`shape1`, `shape2`, … in order of first
  appearance), titled `<title> [<recording folder> | part N]`. Same shapes
  separated in time are joined in time order. The next shape is described and
  uploaded after the previous one is verified online.
- **Short pieces.** A split's piece shorter than a minute is not uploaded: it
  is recorded in the `manual_pieces` table (listed by `review`). If no piece is
  long enough, the recording is blocked for a person.
- **Size.** Each shape is scaled to at least 1920×1080 pixels **and** 1080 tall
  (Porntrex names quality tiers by height), keeping its aspect ratio, and never
  smaller than its largest picture: 1440p/4K keep their size. No crop, no
  padding; square pixels; zscale Lanczos, libx264 slow/CRF 16/yuv420p.
- **Portrait** pictures are turned 90° counterclockwise (`transpose=2`, head to
  the left) into a landscape frame. Artifacts are named
  `<id>.production-v5[-shapeN][-ccw].mp4`; `-ccw` tells the describe stage to show
  the model an upright copy (descriptor option `rotation: "clockwise"`).
- **Segment ownership.** The MPEG-TS scan streams the segment bytes in playlist
  order through one ffprobe keyframe pass; packet byte positions decide which
  segment owns a picture (a frame without a usable position fails the
  analysis). Discontinuities, init-map changes and observed size/SAR changes are
  input boundaries even when the playlist has no tag: each run is opened on its
  own through FFmpeg's concat demuxer, with EXTINF durations as the timeline,
  using temporary run playlists.
- **Imperfect input is kept.** A segment that starts a run without a decodable
  keyframe joins the picture that follows it; such runs are decoded on their
  own (a run with no picture at all holds the previous frame and keeps its
  audio). Odd TS packet sizes and a size change inside a segment are warnings.
  Only zero-byte files are left out of the encoder input (they hold no media).
  Audio is stream-copied when the inputs allow it, else re-encoded once.
- **Limits.** An upload longer than two hours or larger than the provider's
  file limit (Porntrex 10 GB, XVideos 50 GB) is blocked for manual review,
  judged on the artifact's own duration.
- Local work without a `resolution-policy-v5` assessment is reset and
  converted again; uploaded recordings are not touched. The local-stage lease
  is 12 hours.

## Artifacts and generations

Artifacts live in `~/.local/share/video-services/pipeline/artifacts/production-v6/`
(`VIDEO_PIPELINE_ARTIFACTS_ROOT` overrides the common root;
`VIDEO_PIPELINE_STAGING` is accepted as an alias). Its `manual/` child holds
`remux-one` upscale variants. Older generation folders stay until explicitly
pruned. Loose files directly in the artifacts root are moved to
`legacy-production-v1/` whenever the campaign is resumed or prepared.

The database generation is versioned too. When `CURRENT_PRODUCTION_VERSION`
differs from the database's version, the next `campaign:resume` (or
`campaign:prepare`) performs a one-time rollover before changing the campaign
state. It refuses while the campaign is running, a recording lease exists, or
an upload attempt is active. It first saves and syncs a complete SQLite
snapshot under `pipeline/history/<old-production-version>/` (reported as
`historySnapshotPath`), then archives the old recording/upload history under
its version, retires those rows from the active workflow, moves their files
into `artifacts/<old-production-version>/`, and starts discovery again at the
oldest finalized source. Bandwidth accounting, provenance overrides, learned
rejected phrases, provider inventory, campaign provider/limit configuration,
source recordings and the finalization database are preserved.
`campaign:status` reports the active version and whether a rollover is pending.

A new generation reuses a whole-recording artifact from a history snapshot only
when it was produced under the current policy and recipe (`artifact-recipe-v2`)
from the same source fingerprint; split parts are never reused. Descriptions
are reused only through the descriptor's exact artifact-hash/prompt cache.

A description that is not cached starts the descriptor's llama-server, which holds
about 11 GB of RAM. The describe stage first waits until the machine has
`VIDEO_PIPELINE_DESCRIBE_MIN_MEMORY_GIB` (default 16) GiB available: until then the
campaign step is `resource_wait`, retried every 30 seconds, and the recording
keeps its state. Started on a machine short of memory, the server is killed by
the kernel and the recording would fail.

All validated outputs are kept by default. With `VIDEO_PIPELINE_CLEANUP=1` (and
no comparison queue) the worker deletes a verified-online upload's staging
artifact, and forgets recordings older than 24 hours whose source folder is
gone, together with their pipeline files (leased recordings and in-flight
uploads are skipped; `bandwidth_events` are never deleted). The managed service
sets `VIDEO_PIPELINE_CLEANUP=0`. Original downloader/editor folders are never
touched.

## Durable campaign controls

Campaign intent is stored in SQLite independently of worker lifetime.

```bash
npm run campaign:configure -w pipeline -- \
  --provider all --monthly-upload-bytes 600000000000 --apply
npm run campaign:status -w pipeline
npm run campaign:resume -w pipeline
npm run campaign:pause -w pipeline
```

The provider filter may be `all`, `tango`, `fc2`, or `sc`; ordering is always
oldest first. The worker rereads paused/running intent between every durable
stage. `campaign:step` advances at most one admission, local stage, or upload
and is meant for bounded integration testing.

The `video-pipeline.service` user unit (`systemd/user/` at the repository
root) runs `npm run campaign-worker -w pipeline` (`campaign-worker` requires
`VIDEO_PIPELINE_SERVICE_MODE=1`) with `VIDEO_PIPELINE_NETWORK_UPLOADS=1`,
`VIDEO_PIPELINE_CLEANUP=0` and `DISPLAY=:111`. It idles while SQLite says
paused, clears stale leases when it starts, verifies due uploads inline, and
sends desktop notifications for attention pauses, cooldowns, rejected words,
removed videos and errors (`VIDEO_PIPELINE_NOTIFY=0` disables them). Control it
with `systemctl --user start|stop|restart video-pipeline` and the campaign
intent with `campaign:resume` / `campaign:pause`.

A stop sends SIGTERM to the whole unit, so a running stage's ffmpeg or
llama-server dies with the worker. A stage that fails while the worker is stopping
leaves its recording in its state, and the next start resumes it; only a failure
without a stop marks the recording failed.

While the worker runs, its heartbeat makes `remux-one`, `describe-one`,
`process-one`, `upload-one`, `upload-provider:set`, `xvideos:sync`,
`campaign:prepare` and `campaign:select` refuse to start; stop the service
first.

Upload cooldowns pause the campaign with a resume time: a human-action error
(captcha) backs off from one minute, doubling up to 24 hours; a provider login
problem or the XVideos daily limit waits 24 hours; another pre-transfer failure
waits 24 hours. A lost Porntrex session pauses until
`npm run ptrex:connect-iphone` restores it.

Failures and blocks retain the stage they came from. Return one to it:

```bash
npm run retry -w pipeline -- RECORDING_ID
```

### Optional per-provider trial cap

```sh
npm run campaign:configure -w pipeline -- --provider all --trial-per-provider 10 --apply
```

With a cap, the worker admits at most N recordings per provider (tango, fc2,
sc), oldest eligible first; queued work also consumes slots and cannot bypass
older sources. Slots persist across restarts, pauses, retries and missing
sources; failures and uncertain uploads keep their slot. Once every admitted
recording is verified, the campaign pauses; a shortfall or failed/blocked slot
pauses it for attention instead. The next `campaign:resume` after a finished
trial clears the cap and continues normal oldest-first processing; a resume
during the trial keeps it. Change the size while paused with
`--trial-per-provider N`, or cancel it with `--trial-per-provider none`.
`campaign:status` shows `trialPerProvider`, `trialFinishedAt` and per-provider
admissions.

### Optional selected comparison queue

`npm run campaign:prepare -w pipeline` (campaign paused, worker stopped)
performs any pending rollover and arms a selection-only comparison queue,
leaving the campaign paused. While that queue exists the worker processes and
uploads only selected recordings, never discovers others, pauses when a
selected recording fails, keeps every artifact (cleanup and the source sweep
are off), and titles uploads with the diagnostic suffix
`[<recording folder> | production-v6 | <part>]`. No command removes the queue;
only the next production rollover clears it.

Select recordings with one full, unquoted edited recording-folder path per line
(blank lines and `#` comments ignored):

```sh
npm run campaign:select -w pipeline -- --file /absolute/path/selection.txt --apply
```

Valid paths queue in file order; invalid lines are reported, not admitted.
Re-running with an edited file removes pending entries the file omits; recordings that already started a local stage keep their workflow and
evidence. The worker does not watch the file. While the queue exists,
`comparison:report` writes `artifacts/production-v6/comparison.md` (original → local MP4 → uploaded copy)
and `comparison.json` (source fingerprints, policy decision, artifact
path/SHA-256/size, remote ID, verification). Online verification is not a
frame-fidelity test or human quality approval.

## Upload providers

The destination lives in SQLite (`campaign_control.upload_provider`, `xvideos`
or `porntrex`; a new database starts with `xvideos`), not in the credentials
file. Show it, or switch while the campaign is paused and its worker stopped:

```sh
npm run upload-provider -w pipeline
npm run upload-provider:set -w pipeline -- --provider porntrex
```

A switch is refused while any reservation/attempt is in flight or the provider
being left still has open confirmations. Leaving XVideos also requires an
account inventory synchronized after its last upload (`xvideos:sync`, below).
Confirmations always verify on the provider their attempt used.

Credentials live in `~/.config/video-services/upload-providers.json` (chmod
600 is enforced; format in `config/upload-providers.example.json`; override
`VIDEO_UPLOAD_PROVIDERS_FILE`). Both uploaders drive a headed Chromium
(`/usr/bin/chromium`, override `VIDEO_CHROMIUM_PATH`) through a persistent
profile; outside the service set `DISPLAY=:111`. Only one Chromium may use a
profile directory at a time.

Before any bytes are sent, an upload checks: the recording has no verified or
pending remote copy in the ledger, passed `resolution-policy-v5`, fits the
provider's duration/size limits, contains no learned rejected phrase, has no
copy in a synchronized provider inventory, fits the monthly budget, and (for a
retry) is not found by an exact lookup. A submitted upload is never accepted on
submit alone: the attempt parks as uncertain and is verified about 24 hours
later. Recovery rules are in `docs/upload-recovery.md`.

### Porntrex

Uploads are public, in the Webcam category. The profile is `VIDEO_PORNTREX_BROWSER_PROFILE` (else
`VIDEO_XVIDEOS_BROWSER_PROFILE`, else `~/.config/chromium-agent`). Porntrex
keeps one session per account, so the pipeline and the Video Vault iPhone app
share one session, stored in `~/.config/video-services/porntrex-session.json`
(chmod 600; override `VIDEO_PORNTREX_SESSION_FILE`). The pipeline never signs
in on its own: an upload or the worker's ten-minute keep-alive check that finds
the session logged out pauses the campaign.

```sh
npm run ptrex:connect-iphone -w pipeline
```

pauses a running campaign, waits for the current upload and the browser
profile, signs in only if needed, copies the session into the phone app through
the Mac (`VIDEO_MAC_SSH_TARGET`, `VIDEO_MAC_KNOWN_HOSTS`, `VIDEO_IPHONE_DEVICE`),
checks both, and resumes the campaign if it was running or paused for a lost
session.

The transfer follows the page's own progress bar and fails after ten minutes
without progress. Porntrex creates the video only when the metadata form is
submitted, so a failure before that click is a plain failure with no weekly
hold; after it, the pipeline tries for about a minute to read the new video's
ID from My Videos (otherwise reconciliation finds it by its title suffix).
Verification opens `/edit-video/<id>/`, follows the published `/video/<id>/`
link and probes each MP4 download link, highest label first, for a Full-HD
pixel count. A video still processing is checked again after two hours. Words
Porntrex silently replaced in the stored title/description are learned as
rejected phrases.

Read-only reports on the shared session (they never sign in):

```sh
npm run ptrex:session-report -w pipeline
npm run ptrex:uploads -w pipeline -- --limit 25
npm run ptrex:tiers -w pipeline -- --record /absolute/tiers.jsonl
```

### XVideos

Uploads use Direct-link (private) visibility. The default profile is
`~/.config/chromium-agent` (override `VIDEO_XVIDEOS_BROWSER_PROFILE`); the
uploader opens it with remote debugging on port 9222, so close any other
agent-controlled browser first. To set it up on a fresh clone, launch
`/usr/bin/chromium --user-data-dir=/home/visar/.config/chromium-agent` once,
put the credentials in the providers file, confirm the account dashboard shows
"My Content", and close the browser. The canonical agent-profile notes live in
`~/Documents/environment/browser/chromium-agent.md`.

The uploader signs in through the native email/password form (only visible
login fields count). On the upload page it completes Friendly Captcha itself:
it clicks the widget's "I am human" checkbox, waits for the proof-of-work,
clicks "Confirm that you are not a robot", and only then expects the file form;
if the captcha still needs a person it fails with `HumanActionRequiredError`.
After the file upload starts, actions use five-minute timeouts. The streamer
alias is typed into the zero-width model typeahead with keyboard events and
saved without selecting a model. A manual run leaves the browser open on
failure (logged as `upload-browser-left-open`; close it before retrying); the
managed worker closes it.

Verification opens `/account/uploads/<id>/edit`: the video is online when the
page has the direct video link (`/video.<key>/<slug>`) and its HLS master
advertises a Full-HD rendition. An edit page answering HTTP 404 means the video
is gone: the recording is blocked for review and `retry` re-uploads it.

`xvideos:sync` reads the complete uploads listing (its count must equal the
account total) into `provider_inventory`:

```sh
VIDEO_PIPELINE_NETWORK_UPLOADS=1 DISPLAY=:111 npm run xvideos:sync -w pipeline
```

It settles every open XVideos confirmation from that inventory (IDs missing
from it are dropped, absent recordings are requeued after their deadline,
existing copies are made due for verification) and reports verified uploads
missing from the account, account videos unknown to the ledger and duplicate
copies without acting on them. Uploads to any provider then refuse recordings
with a copy in a synchronized inventory; no other provider is logged into for
that check.

## Rejected metadata phrases

Providers refuse some words in titles/descriptions (XVideos: "Sorry, 'ambien'
is not allowed here.") and match them as case-insensitive substrings, so
innocent words trip them: "ambient" (ambien), "high-waisted" (waisted),
"scrolling on" (rolling on), "breathing" (breath). Such a refusal means the
form was never validated and no video exists. The pipeline therefore:

- learns every refused phrase per provider in SQLite (`rejected_phrases`), plus
  the words Porntrex silently replaced in a published video,
- appends all learned phrases to the description prompt (the base prompt file is
  unchanged; the appended text is part of the prompt version),
- checks composed metadata locally before any reservation or byte is sent. A
  hit is first rewritten by the local model; if that fails, a description
  older than the current prompt is described again, otherwise the recording is
  blocked for manual review,
- records a refusal during upload as a definitive failure (bytes still count,
  no weekly duplicate hold, no reconcile) and returns the recording to
  upload-ready, where that check runs again.

`npm run metadata:check -w pipeline [-- --provider xvideos|porntrex]` is the
read-only version of that check over every composed, not-yet-verified recording
(default: the active provider). Visibility labels on published videos ("limited
visibility due to : alcohol…") are informational only and never affect retries.

## Commands

Run isolated tests (generated media and databases under the system temporary
directory only):

```bash
npm test -w pipeline
```

Inspect the ledger, and list everything that needs a person (blocked
recordings with reasons, unresolved provenance, `manual_pieces`):

```bash
npm run status -w pipeline
npm run review -w pipeline
```

Preview or apply finalized-recording discovery. Applying writes only the
pipeline ledger and is refused until the server's historical finalization
contract is complete:

```bash
npm run discover:plan -w pipeline
npm run discover -w pipeline
```

`remux-one` makes a stream-copy MP4 of one managed downloader or edited folder
for inspection, in a systemd scope under `video-processing.slice`. If the
folder's server checkpoint is absent or stale, it first finalizes that folder
with the server processor; with `VIDEO_PIPELINE_NETWORK_UPLOADS=1` it first
looks the folder up on the active provider and parks an existing upload
instead. This is not the production conversion: the campaign
converts the recording again, and `upload-one` refuses an artifact that has not
passed `resolution-policy-v5`.

```bash
npm run remux-one -w pipeline -- --recording "/absolute/managed/recording/folder"
```

The same command can write a named upscale variant to `artifacts/production-v6/manual/`
without changing the recording's artifact or upload state:

```bash
npm run remux-one -w pipeline -- \
  --recording "/absolute/managed/recording/folder" --upscale1080p

npm run remux-one -w pipeline -- \
  --recording "/absolute/managed/recording/folder" --upscale1440p
```

The flags are mutually exclusive. `--upscale1080p` drops decoded source frames
whose coded short edge is below 720 pixels and targets a 1080-pixel short edge;
`--upscale1440p` uses a 1080-pixel floor and a 1440-pixel target. Both keep the
display aspect ratio (portrait stays portrait) with no crop or padding, use
zscale Lanczos plus libx264 slow/CRF 16/yuv420p, and stream-copy audio. Files
end in `.upscale1080p.mp4` or `.upscale1440p.mp4`; their validation records live
in `artifact_variants`. They are never campaign/upload inputs.

Describe a recording's validated artifact and compose its upload metadata
durably (bounded systemd scope):

```bash
npm run describe-one -w pipeline -- --recording RECORDING_ID
```

For prompt experiments outside the durable upload flow, use the descriptor
package directly:

```bash
npm run describe-one:bounded -w descriptor -- "/absolute/test-video.mp4"
```

`process-one` is a low-level debugging worker. It advances one already-admitted
edited recording by one stage; it is not the operator-facing campaign:

```bash
npm run process-one -w pipeline
```

Refresh provenance, then inspect unresolved identifiers grouped by provider and
observed folder alias:

```bash
npm run provenance:refresh -w pipeline
npm run provenance:review -w pipeline
```

One manual override applies to every matching recording (`--alias-url` is
optional):

```bash
npm run provenance:set -w pipeline -- RECORDING_ID \
  --streamer-id ID --alias NAME --streamer-url URL --alias-url URL
```

Preview upload admission without credentials, reservations, or network access:

```bash
npm run dry-run -w pipeline
```

Manual network commands need both the explicit mutation flag and the
environment opt-in; `upload-one` also refuses while the worker runs:

```bash
VIDEO_PIPELINE_NETWORK_UPLOADS=1 DISPLAY=:111 npm run upload-one -w pipeline -- \
  --recording RECORDING_ID --apply

VIDEO_PIPELINE_NETWORK_UPLOADS=1 DISPLAY=:111 npm run reconcile-uploads -w pipeline
```
