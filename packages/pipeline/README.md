# Durable video pipeline

This package owns the months-long per-recording processing queue. It remains
separate from Express; the managed `video-pipeline` campaign worker runs it
under systemd.

## Active environment: v3 selected comparison queue

The current release is a safety/quality test, not unrestricted production.
`production-v3` has its own upload title identities and artifact directory.
Only paths explicitly selected through the comparison queue can be processed or
uploaded. Automatic oldest-first discovery and the v2 10-per-provider trial are
not used by this environment.

Selection file: `~/.local/share/video-services/pipeline/test-videos.txt`.
Put one full, unquoted **edited recording-folder path** per line (the folder
contains `playlist.m3u8`). Blank lines and `#` comments are ignored. The managed
worker checks the file every 30 seconds, including during conversions and
cooldowns, and also before campaign steps. Valid paths form a durable queue in
file order. Removing a pending path cancels it; reordering changes pending order.
Admission alone is still pending until a local stage has been claimed. Active,
previously attempted, and completed recordings retain their workflow/evidence;
removing or re-adding them does not undo processing or repeat uploads. Invalid lines
are reported, not admitted; they are retried after corrections. There are no
library-wide probes: only new selected paths are checkpoint/fingerprint checked.

When the queue drains, the enabled worker waits for more paths. A manual pause
prevents processing, but file additions may still queue. Resume never switches
v3 to unrestricted discovery. Failures pause the campaign for attention without
substituting other videos. Saving the file does not enable a stopped worker.

All validated outputs are retained, including after upload verification, manual
identity checks and source-removal sweeps. Comparison retention overrides even
`VIDEO_PIPELINE_CLEANUP=1`; the managed service explicitly sets cleanup to 0 and
cleanup elsewhere now defaults off. Only an explicit later deletion request
should remove comparison evidence. Source files are never modified.

`artifacts/production-v3/comparison.md` links **original → local MP4 → uploaded
copy**. The adjacent `comparison.json` records source fingerprints, the policy
decision, exact artifact path/SHA-256/size, remote ID and online verification.
The report refreshes with the worker and verification. Online verification is
not a frame-fidelity test or human quality approval.

Prepare a new generation without starting work:

```sh
npm run campaign:prepare -w pipeline
```

Preparation snapshots the old database (including descriptions and metadata),
archives its active ledger, retains old-version artifacts in their existing
version folder, and leaves v3 paused. It does not import or start the selection.
To explicitly ingest while the worker is stopped:

```sh
npm run campaign:select -w pipeline -- --file /home/visar/.local/share/video-services/pipeline/test-videos.txt --apply
```

Once the user approves starting, `campaign:resume` enables queue consumption and
the managed service must be started. `comparison:report` refreshes the report
on demand. The resolution routing policy below is unchanged.

### Controlled safety regressions (2026-09-09)

TS classification now streams playlist-ordered segment bytes through a single
position-aware ffprobe scan. Keyframe packet byte positions establish segment
ownership; equal keyframe distribution is never assumed. Unknown ownership,
missing keyframes, or changing dimensions/SAR within a segment fail closed.
This does not launch a per-segment probe sweep.

Production remux and conversion also treat observed dimension/SAR changes as
input boundaries when source discontinuity tags are missing. They reuse the
policy's dimension scan; sources and validation checkpoints are not modified.
Downloader tagging is the first line of protection for new captures; pipeline
normalization also protects historical/untagged input. Untagged TS 360p/720p/360p tests cover both
orientations and both continuous and reset timestamps, retaining every frame
and AAC packet in conversion.

Production conversion normalizes discontinuity/init-map/geometry runs through FFmpeg's
concat demuxer, with EXTINF durations preserving the intended timeline. A
three-run fMP4 fixture previously lost 12 of 18 frames; the regression now
asserts every distinct frame ID, presentation time, and copied AAC packet.
Retained-remux fixtures also exercise prefix/suffix/repeated cuts and unchanged
map transitions. Tests operate only on generated media and isolated databases
under the system temporary directory, never on the selected library recordings.
Separate subprocess tests kill an actual encoder and paused worker, checking
atomic output publication, lease recovery and file-driven queue updates.
These checks do not certify provider encoding quality or the Irina recording;
those remain part of the explicitly approved original/local/upload comparison.

Implemented:

- SQLite WAL/FULL recording state, transition events, leases, artifact hashes,
  description evidence, provenance, metadata, upload attempts, transmitted-byte
  accounting, and remote upload identity. Recording IDs are the source folder
  names (datetime + alias) — the disk is the source of truth.
- Production discovery of only exact server-checkpointed `edited`
  recordings. Hidden handoff directories and raw downloaded recordings are
  excluded from campaign processing.
- Legacy disk-truth sweep (disabled for comparisons): recordings whose source folder is
  missing are deleted from the ledger with their pipeline files (24-hour
  cooldown, in-flight uploads skipped). ISP billing (`bandwidth_events`) is
  never refunded or deleted.
- Segment-aware production resolution policy, full decode/probe, SHA-256
  evidence, and exact-artifact description.
- Server-delegated per-provider identity resolution through
  `GET /api/{provider}/resolve` (Tango alias registry + live Tango API, FC2
  numeric IDs, Stripchat username lookup), grouped unresolved review, and
  reusable manual overrides.
- Production identity uses the versioned local ledger and captured provider edit
  ID, not natural-language title matching. Comparison titles retain a diagnostic
  recording/version/part marker for their additional remote lookup.
- Public campaign titles contain only the descriptive title. Prepared comparison
  trials explicitly append diagnostics. Provenance suffixes stay in descriptions;
  provider/live tags are unchanged.
- Persistent-Chromium XVideos upload through Google OAuth, automated
  Friendly Captcha completion with a manual fallback, streamer alias typed
  into the model search without selection, fixed metadata policy, and 24-hour
  edit-page verification.
- Calendar-month upload admission capped at 600,000,000,000 bytes in
  `Europe/Tirane`, restart recovery, and a 24-hour no-retry confirmation window
  after metadata submission may have succeeded.
- Legacy opt-in cleanup runs only on verified-online uploads and deletes only the pipeline
  staging artifact; original downloader/editor folders are never touched
  (off by default, and always disabled for comparison queues).
- `review` lists everything that cannot be solved programmatically: blocked
  recordings with reasons, and unresolved provenance.

The historical finalization contract is complete, and one controlled upload
has gone the full circle: submitted, published on XVideos, verified online
through the edit-page check, and its staging artifact cleaned. Network
commands remain gated behind `VIDEO_PIPELINE_NETWORK_UPLOADS=1`. The managed
`video-pipeline` campaign worker performs upload verification inline; there is
no separate reconcile timer.

## Production resolution policy

The campaign classifies every HLS segment by coded pixel count (`width * height`).
High-quality means **at least 1920 * 1080 = 2,073,600 pixels**, independent of
orientation or aspect ratio. SAR/display stretching does not add coded pixels.
For example, 2560x900 qualifies; 1440x1080 does not. For fMP4, the last active
`#EXT-X-MAP` attached to a segment owns its dimensions; unused consecutive map
tags are ignored. MPEG-TS uses one whole-playlist keyframe scan rather than an
`ffprobe` process per segment.

- A recording whose segments all have fewer than 2,073,600 pixels is fully transcoded to a
  1080-pixel short edge. Lower-resolution segments are included in that same
  conversion, not dropped. The conversion preserves one consistent display
  aspect ratio with no crop or padding, uses zscale Lanczos plus libx264
  slow/CRF 16/yuv420p, stream-copies audio, and publishes a named
  `.production-upscale1080p.mp4` artifact.
- If every segment meets the pixel threshold, stream-copy remux them all at their native
  resolutions, including mixtures such as 1080p/1440p. No upscaling or downscaling.
- Otherwise measure the **pixel-qualified** share by summed playlist `EXTINF`
  durations, not segment/frame counts. The trigger is total pixels, not a
  short edge, exact dimensions, or the highest resolution present.
  At **90% or more**, exclude the lower-resolution segments and stream-copy
  remux all retained qualifying segments to `.retained1080p.mp4` (the suffix
  refers to the Full HD pixel threshold, not fixed dimensions). Below 90%, convert the
  **entire recording** to `.production-upscale1080p.mp4`, dropping nothing.
  Both paths produce one upload, never two. Gaps and map changes are represented
  by HLS discontinuities; source folders and their playlists are never modified.
- Conversion requires one consistent display aspect ratio; incompatible aspect
  changes fail safely rather than stretching/cropping or adding padding.
  Native remux keeps the original encoded geometry. Independent init/geometry
  runs are concatenated with their own decoder parameters and continuous timing.
  This pixel-count change affects classification only; conversion still targets
  a 1080-pixel short edge while preserving aspect ratio, not a fixed output pixel budget.

Only prepared comparison uploads carry the diagnostic title suffix
`[recording ID | production-v3 | full]`. Normal campaign titles are clean by
default. Version separation stays in the local ledger and artifact paths.
Captured provider edit IDs drive verification; a missing ID or interrupted
transfer is acceptance-unknown and cannot trigger an automatic re-upload.
Clean titles are never searched to guess identity, including when two videos
have identical descriptive titles. Keep the ledger/backups: clean public titles
are not a substitute for lost identity records. Legacy split-part ledger support
remains for existing data, but resolution-policy-v3 no longer creates split uploads.

Artifacts use the same generation boundary:
`pipeline/artifacts/<production-version>/`. The first v2 rollover atomically
moves unversioned files to `artifacts/legacy-production-v1/`; production-v2
outputs are written only below `artifacts/production-v2/`, with supervised
comparison variants isolated in its `manual/` child. Old generation folders
remain available until explicitly pruned. `VIDEO_PIPELINE_ARTIFACTS_ROOT`
overrides the common artifact root; the old `VIDEO_PIPELINE_STAGING` name is
accepted as a compatibility alias for that root.

The active database generation is versioned too. The first explicit
`campaign-resume --apply` after a production-version change performs a one-time
rollover before setting the campaign to running. It archives the previous
recording/upload history under its production version, retires those rows from
the active workflow, and archives their staging files, after which normal
discovery starts again at the oldest finalized source. Bandwidth accounting,
provenance overrides, campaign provider/limit configuration, finalized source
recordings, and the finalization database are preserved. `campaign-status`
reports the active version and whether this rollover is pending.
Rollover refuses to start while the old campaign is running, a recording lease
exists, or an upload attempt remains active.
Before any rollover moves files or retires workflow rows, it saves and syncs a
complete SQLite snapshot under `pipeline/history/<old-production-version>/`.
This preserves all old descriptions, composed upload titles/descriptions,
provenance and workflow records, not just the narrower retired upload tables.
The resume result reports `historySnapshotPath`. New-artifact description reuse
still follows the exact artifact-hash/prompt cache; changed artifacts are
described again rather than inheriting possibly stale descriptions.

### Historical v2 one-time per-provider trial (not active in v3)

Configure a 30-recording trial without starting anything:

```sh
npm run campaign:configure -w pipeline -- --provider all --trial-per-provider 10 --apply
```

When ready, `npm run campaign:resume -w pipeline` starts the armed trial (the
worker service must also be running). The worker takes the oldest eligible
10 source recordings per provider: tango, fc2, and sc. Existing queued work
also consumes slots and cannot bypass older sources. Monthly bandwidth limits,
upload guards, and cooldowns still apply; configuring the trial does not reset
the existing monthly byte limit. `npm run campaign:status -w pipeline` shows
`trialPerProvider`, `trialFinishedAt`, and per-provider admissions/recording states.

Trial slots persist across restarts, temporary pauses, retries, and missing
sources. Failures and uncertain uploads keep their slot rather than being
replaced with extra videos. Once all thirty are verified, the campaign pauses
indefinitely; it does **not** automatically start the unrestricted run. After
submission, it waits for the usual delayed inline verification without admitting
extra recordings. Confirmed-absent uploads may retry in the same slots. Fewer
than ten eligible sources in a provider or failed/blocked sources cause an
attention pause, not a successful trial finish; the cap remains on resume.
Submission alone is not proof of remote quality or verification.

After reviewing the finished trial, the same `npm run campaign:resume -w pipeline`
clears its one-time cap and continues normal oldest-first processing, retaining
all upload history. A manual pause/resume **during** the trial keeps the cap.
To change its size, pause and reconfigure `--trial-per-provider N`; consumed
slots are preserved until the trial finishes. To cancel the cap explicitly,
use `--trial-per-provider none`. Trial configuration is preserved through the
production rollover, but old-generation slots are not carried forward.

Run isolated tests:

```bash
npm test -w pipeline
```

Inspect the ledger:

```bash
npm run status -w pipeline
```

Preview or apply finalized-recording discovery. Applying writes only pipeline
SQLite and remains blocked until the server's historical contract is complete:

```bash
npm run discover:plan -w pipeline
npm run discover -w pipeline
```

Remux and validate one explicitly selected recording. This supervised command
accepts a managed downloader or edited folder. If the exact server checkpoint
is absent or stale, it first finalizes that one folder with the production
server processor:

```bash
npm run remux-one -w pipeline -- --recording "/absolute/managed/recording/folder"
```

For controlled provider-quality experiments, the same command can create a
named upscale variant without replacing the canonical artifact or changing the
recording's pipeline/upload state:

```bash
npm run remux-one -w pipeline -- \
  --recording "/absolute/managed/recording/folder" --upscale1080p

npm run remux-one -w pipeline -- \
  --recording "/absolute/managed/recording/folder" --upscale1440p
```

These supervised comparison modes remain separate from the production policy.
They are mutually exclusive. `--upscale1080p` drops decoded source frames
whose coded short edge is below 720 pixels and targets a 1080-pixel short edge;
`--upscale1440p` uses a 1080-pixel floor and a 1440-pixel target. Both preserve
display aspect ratio (including portrait video) with no crop or padding, use
zscale Lanczos plus libx264 slow/CRF 16/yuv420p, and stream-copy audio. Their
files end in `.upscale1080p.mp4` or `.upscale1440p.mp4` and their validation
records live separately in `artifact_variants`. They are comparison artifacts,
not automatic campaign/upload inputs.

The result contains a recording ID. Describe that exact validated artifact and
compose its upload metadata durably:

```bash
npm run describe-one -w pipeline -- --recording RECORDING_ID
```

For arbitrary prompt experiments that should not enter the durable upload
flow, use the descriptor package directly:

```bash
npm run describe-one:bounded -w descriptor -- "/absolute/test-video.mp4"
```

`process-one` is a low-level debugging worker. It advances one already-admitted
edited recording by one stage; it is not the operator-facing campaign:

```bash
npm run process-one -w pipeline
```

Refresh provenance, then inspect unresolved identifiers grouped by provider and
observed folder alias. Resolution asks the API server (default
`https://127.0.0.1:9999`, override with `VIDEO_SERVER_URL`) instead of
matching catalog files locally:

```bash
npm run provenance:refresh -w pipeline
npm run provenance:review -w pipeline
```

One manual override applies to every matching recording:

```bash
npm run provenance:set -w pipeline -- RECORDING_ID \
  --streamer-id ID --alias NAME --streamer-url URL --alias-url URL
```

During `upload-one` the browser types the streamer alias into the model
search and saves without selecting any model — verified live that XVideos
accepts the submission with an empty model list and never attaches the model
to the video anyway. The model search input is a zero-width typeahead, so the
uploader types into it with keyboard events instead of `fill()`.



## Persistent XVideos browser profile

The uploader drives a real Chromium through a persistent user-data directory so
the Google OAuth session and XVideos cookies survive between runs. The default
profile is the shared agent-control directory:

```text
/home/visar/.config/chromium-agent
```

Override it with `VIDEO_XVIDEOS_BROWSER_PROFILE=/absolute/path`. Only one
Chromium process may use the directory at a time: close any agent-controlled
browser (remote debugging on port 9222) before running an upload. The uploader
closes its own Chromium only when the upload completes cleanly; on any failure
it leaves the browser open for manual handling and logs
`upload-browser-left-open`, so close that browser before retrying.

Setting the profile up on a fresh clone:

1. Create the profile by launching Chromium once:
   `/usr/bin/chromium --user-data-dir=/home/visar/.config/chromium-agent`
2. Open `https://www.xvideos.com/account`, click the Google login icon and
   then "Sign in with Google", and complete the Google flow with the account
   from `packages/.env` (`EMAIL_XVIDEOS` / `PASSWORD_XVIDEOS`). Accept the
   XVideos consent modal and resolve any Google challenge or captcha by hand.
3. Confirm the dashboard shows "My Content", then close the browser. Cookies,
   local storage, and anti-bot state persist on disk for the next run.

A submitted upload is never accepted on submit alone: the attempt parks as
uncertain with the captured video ID, and `reconcile-uploads` (due 24 hours
later) opens the authenticated edit page `/account/uploads/<id>/edit`. The
presence of the "Direct link to the video page" anchor (`/video.<key>/<slug>`)
is the online success signal; without it the confirmation stays pending.

The uploader handles the remaining sign-in steps itself: the account chooser,
identifier/password entry, the consent "Continue" button — whether the OAuth
flow runs in the same tab or in a popup, and even when a saved Google session
completes it instantly — and the upload page's Friendly Captcha. For the
captcha it clicks the widget's "I am human" checkbox,
waits for the proof-of-work to complete, clicks the page's "Confirm that you
are not a robot" button, and only then expects the file form. If the captcha or
a Google challenge still demands human help, the upload command fails with a
`HumanActionRequiredError` instead of retrying blindly. Once the file upload
has started, the run uses patient five-minute action timeouts and never closes
the browser on failure; any post-upload failure is recorded as
acceptance-unknown and must be verified with `reconcile-uploads` (24 hours
after submission), which checks the edit page for the direct video link,
before the recording becomes retryable, so a retry cannot silently upload the
same video twice. The canonical agent-profile notes live in
`~/Documents/environment/browser/chromium-agent.md`.

Preview upload admission without credentials, reservations, or network access:

```bash
npm run dry-run -w pipeline
```

Real network commands require both the explicit mutation flag and environment
opt-in:

```bash
VIDEO_PIPELINE_NETWORK_UPLOADS=1 npm run upload-one -w pipeline -- \
  --recording RECORDING_ID --apply

VIDEO_PIPELINE_NETWORK_UPLOADS=1 npm run reconcile-uploads -w pipeline
```

Do not run those commands unattended until the production blockers are cleared.

## Durable campaign controls

Campaign intent is stored in SQLite independently of worker lifetime. The
campaign consumes only edited recordings with exact current server checkpoints
and orders them by the timestamp in the folder name—not by finalizer scan time.

```bash
npm run campaign:configure -w pipeline -- \
  --provider all --monthly-upload-bytes 600000000000 --apply
npm run campaign:status -w pipeline
npm run campaign:resume -w pipeline
npm run campaign:pause -w pipeline
```

The provider may be `all`, `tango`, `fc2`, or `sc`; ordering is always oldest
first. The worker rereads paused/running intent between every durable stage.
`campaign:step` advances at most one admission, local stage, or upload and is
available for bounded integration testing.

The managed `video-pipeline.service` runs the campaign worker at boot and
idles while SQLite says paused; it is power-off robust. Control it with
`systemctl --user start|stop|restart video-pipeline` and the campaign intent
with `campaign:resume` / `campaign:pause`. Due upload verification runs inline
in that worker.

Failures retain their last successful stage. Retry an eligible local failure:

```bash
npm run retry -w pipeline -- RECORDING_ID
```
