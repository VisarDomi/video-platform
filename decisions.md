# System decisions

This file records the system-level rules that hold on `main` and why. It describes
the current state only; how it came to be is in git history. Package detail lives
next to the code: `packages/downloader/decisions.md`, `packages/server/decisions.md`,
`packages/pipeline/README.md` (+ `docs/upload-recovery.md`),
`packages/descriptor/README.md`, `packages/app/decisions.md`, `apps/ios/PORT.md`,
`packages/auth/decisions.md`, `packages/shared/decisions.md`, `systemd/README.md`.

## 1. Components and ownership boundaries

| Package | Runs as | Owns |
|---|---|---|
| `packages/auth` | `video-auth.service` | Tango session tokens |
| `packages/downloader` | `video-downloader.service` | live capture into `.active` folders |
| `packages/server` | `video-server.service` (HTTPS :9999) | finalization, library/HLS API, edits, download lists, provider identity resolution, serving the `packages/app` build |
| `packages/pipeline` | `video-pipeline.service` | conversion, description, upload, verification |
| `packages/descriptor` | library (no unit) | local model titles and descriptions |
| `packages/app` | served by the server; online builds for the iPhone | web UI, Video Vault, Tango live viewer |
| `packages/live-extensions` | Safari extensions in the Tango iPhone app | FC2/SC download-list buttons |
| `packages/shared` | library | layout, playlist parsing, upload policy, token reader, logger |

A recording changes owner only by an atomic rename on one filesystem:

```text
<provider>/downloaded/.active/<rec>    downloader writes; ENDLIST, then rename
<provider>/downloaded/.pending/<rec>   server finalizes; then rename
<provider>/downloaded/<rec>            visible library
<provider>/edited/<rec>                server edit output; the only pipeline input
<provider>/trash/<rec>                 edited-away originals and manual trash moves
```

- **Filesystem location is the lifecycle authority.** No service protocol connects
  capture, finalization and processing. Why: each process can lose power on its
  own, and a rename is a single-writer handoff that survives that.
- **The layout is defined once**, in `packages/shared/src/providerLayout.ts`
  (`downloadsRoot`, `providerFolder()`, `providerFolders()`). The default root is
  `~/Videos/downloads`, overridden by `VIDEO_DOWNLOADS_ROOT`. The providers are
  `tango`, `fc2` and `sc` (Stripchat). Server, downloader and pipeline all derive
  their roots from this module.
- **Service data lives outside the checkout**, in `~/.local/share/video-services`:
  `finalization.sqlite`, `pipeline/{pipeline.sqlite,artifacts,history,descriptions}`,
  `download-lists/`, `session/`, `live-status.json`.
  - `VIDEO_SERVICES_DATA_ROOT` is honoured by the shared layout module (download
    lists), the pipeline and the descriptor. Downloader, server, auth and
    `readTokens()` hardcode the default path.
  - Secrets live in `~/.config/video-services/`. The pipeline refuses
    `upload-providers.json` and `porntrex-session.json` unless they are `chmod 600`.
- **A folder name is the recording's identity**: `YYYY-MM-DD HHMMSS <alias>`, in
  local time. The pipeline's recording ID is that name. If two providers have the
  same name, the recording is blocked for review.

| Shared resource | Single writer | Readers |
|---|---|---|
| `download-lists/tango.txt` | server routes, `AliasRegistry.syncTangoTxt` | downloader (`TangoTargetManager`) |
| `download-lists/sc.txt` | server routes, hourly `syncScTxtAliases` | downloader |
| `download-lists/fc2.txt` | server routes | downloader |
| `aliases.json` | server `AliasRegistry` (hourly, and on Tango add/resolve) | server |
| `session/<account>.json` | auth daemon | server, downloader (`readTokens()`) |
| `live-status.json` | downloader `DownloadsManager` | nobody; informational only |
| `finalization.sqlite` | server | pipeline (read-only) |
| `pipeline/pipeline.sqlite` | pipeline | pipeline commands |

The downloader writes a list file only to create a missing one (comments only). It
never touches aliases or the Tango follow list. When a Tango target is added, the
server follows the account first, but only if it is not already followed.

## 2. Capture (downloader)

- **Ownership:** the downloader owns `<provider>/downloaded/.active/<rec>/`. At the
  end of a recording it writes `#EXT-X-ENDLIST` atomically and renames the folder
  to the sibling `.pending/`. Shutdown or power loss leaves `.active` unfinished
  (no ENDLIST), and the next start resumes it.
- **Filenames:** `{local-number}_{recording-identity}_{provider-sequence}.ts`, where
  the identity is Tango `streamId`, FC2 `start_time` or Stripchat `statusChangedAt`.
  UTC identities keep the `Z` but drop the colons (`2026-08-12T090847Z`), and
  percent-escapes are never stored. Files are created with `wx`, so media is never
  overwritten. Old numeric names stay valid and are never renamed.
- **Capture never discards media.** Provider numbering restarts are new media: a
  window more than `window + SEQUENCE_RESTART_MARGIN_SEGMENTS` (10) segments below
  the last saved segment is accepted after a discontinuity and logged as
  `SEQUENCE-RESTART`. The baseline is the last saved segment, not the maximum,
  also after a restart. Why: providers do restart (SC per edge, Tango at 0, FC2
  arbitrarily). An empty download is fetched again on later polls, up to
  `REJECTED_SEGMENT_MAX_ATTEMPTS` (5) times; a file unreadable after writing stays
  on disk; files a crash left after the playlist tail are re-appended on resume.
- **Geometry is tagged at capture.** Tango and FC2 ffprobe each saved segment for
  width, height and SAR (5 s timeout); a failed probe never rejects a segment, every
  resolution is kept, and a changed or unknown size gets an `#EXT-X-DISCONTINUITY`.
  They keep the upstream EXTINF until the server rewrites it. SC is fMP4: a new
  init map gets a discontinuity plus `#EXT-X-MAP` (`init_<n>.mp4`), and EXTINF
  comes from `sidx` parsing.
- **End of a recording:** provider snapshots decide it, not HLS transport errors.
  An upstream ENDLIST, a different recording identity or a Tango live-playlist 404
  is immediately terminal. Absent or non-public is terminal only after at least two
  successful observations 60 s apart with no media progress; a failed provider
  lookup proves nothing. Removing a streamer from its download list ends the
  session at once.
- **Polling:** Tango every 1 s, SC every 5 s, FC2 every 30 s (FC2 uses only the
  adult channel-list endpoint).
- **Startup reconciliation of `.active`:** a folder without media goes to desktop
  Trash; one with ENDLIST completes its handoff; a legacy folder is handed off
  without guessing an identity; mixed identities are left untouched; anything else
  resumes after a discontinuity.
- **Disk guard:** the server checks every 60 s and stops `video-downloader` below
  50 GiB free (`diskSpaceMonitor.ts`).

## 3. Finalization and integrity (server)

- **Mailboxes.** Each `<provider>/downloaded/.pending` is permanent and created at
  boot. It is watched directly and non-recursively, one `fs.watch` per mailbox,
  registered before the startup reconciliation. A safety reconciliation runs
  hourly (`CATCH_UP_INTERVAL_MS`). There is no `edited/.pending`. Why: a recursive
  watch costs one inotify watch per recording folder and exhausts the system
  budget.
- **Steps for each recording:**
  1. mark provider sequence restarts with discontinuities;
  2. rewrite EXTINF (`PlaylistAuthority`);
  3. list unreferenced files;
  4. validate;
  5. atomically rename into `<provider>/downloaded/`.

  The queue is one deduplicating FIFO with `os.availableParallelism()` workers. Each
  worker waits 15 s between recordings (`QUEUE_COOLDOWN_MS`).
- **Finalization is non-destructive.** It may rewrite only `playlist.m3u8`
  (durations and discontinuity tags). It never removes an entry and never moves or
  deletes a media file.
  - Problems become `warnings` on a `ready` report and the recording still
    publishes. The kinds are `damaged-segments`, `unattributed-damage`,
    `validation-incomplete`, `unreferenced-media`, `sequence-restart` and
    `retired-repair-journal`.
  - `failed` means only that the environment failed (ffmpeg could not run, or I/O
    failed). It is retried later.
  - `empty` (no entries and no unreferenced media) moves the folder to desktop
    Trash.
  - Why: segments that fail a strict decode still hold real, mostly playable
    media, and a numbering restart is new media. Removing either loses content.
- **Validation:** ffmpeg decodes each native run (split at discontinuities, gaps
  and map changes) to the null muxer. Per-segment decoding runs only after a run
  fails, with a checkpoint every 25 segments so a restart resumes. The harmless
  null-muxer non-monotonic-DTS message, and a repeat summary directly after it,
  are filtered out. `MEDIA_INTEGRITY_VALIDATOR_REVISION` is 4.
- **Checkpoints** are in `finalization.sqlite` (`integrity_checkpoints`, keyed by
  path plus the playlist's SHA-256). The whole pipeline contract is a matching
  fingerprint, `version === 2` and `status === "ready"`.
- **Durations (`PlaylistAuthority`):** EXTINF is the difference between the first
  video PTS of adjacent MPEG-TS segments, read from the bytes. ffprobe runs only
  where bytes cannot answer (before a discontinuity, the tail, a failed byte
  probe), falling back to `max(video, audio)` stream duration, then
  `format.duration`. Writes are temp file, fsync, rename. fMP4 playlists
  (`#EXT-X-MAP`) are skipped (`fmp4-map`). Why: Safari/iOS plays the media
  timeline, not the MPEG-TS container span. One measured recording had 2247.68 s
  of container time against 2127.75 s of video, which misplaces segment names and
  edit cuts.
- **`playlist.m3u8` is the only timeline artifact.** There is no sidecar duration
  file, and HLS GET routes never repair a playlist.
- **Backfill:** `npm run finalize-library -w server` runs the same processor. It is
  a dry run unless given `--apply`; it also takes `--provider`, `--scope`,
  `--recording` and `--limit`.
- **Warnings are not shown in the UI.** They exist only in checkpoint JSON, the
  journal and CLI output.

## 4. Library, editing and playback

- **Every video reference carries its provider.** HLS routes are
  `/hls/:provider/:filename/playlist.m3u8` and `/hls/:provider/:filename/:segment`.
  `resolveVideo(filename, provider)` returns a `VideoRef` and searches only that
  provider's `downloaded/.active`, `downloaded` and `edited`. The frontend `Video`
  carries `provider`. Why: a cross-provider search can match another provider's
  folder.
- **Edits.** The frontend turns markers into explicit segment names using the
  playlist timeline. The backend then:
  1. moves exactly the matching `.ts` files into `<provider>/edited/.building-<uuid>`
     and copies the init files;
  2. derives the playlist from the original plus the requested set;
  3. writes a `ready` checkpoint by derivation
     (`trustedDerivation: "edited-from-validated-recording"`, no decoding);
  4. renames the build into `<provider>/edited/`;
  5. moves the rest of the original to `<provider>/trash/`.

  Media is validated once, at capture finalization.
- **Playlist repair breaks pipeline readiness.** `POST /api/videos/:filename/repair-playlist`
  and `/api/videos/repair-playlists` rewrite published playlists. The new
  fingerprint makes the pipeline treat the recording as unready until
  `finalize-library` checkpoints it again.
- **Frontend rules** (detail in `packages/app/decisions.md`):
  - Three `PlayerUnit`s and one fixed `OverlayView`. The current video contains
    the visual viewport's midpoint; only it feeds the overlay and saved progress.
    Only the overlay's controls paint, because a full-box background makes
    Safari's browser chrome opaque.
  - Safari owns the leading-edge back gesture (28 px), multi-touch, vertical
    scrolling and pinch; the viewer prevents default only for its horizontal seek.
    Viewer-to-viewer navigation uses `history.replaceState()`.
  - List rows are plain anchors. A bfcache `pageshow` refetches without moving the
    restored scroll; one poller runs. The highlight is kept in `localStorage`
    (`video-highlight:<provider>`).
  - There is no frontend log service or server log route.
- **Providers in the app.** Local providers (`tango`, `fc2`, `sc`) can save, edit
  and return. Online ones (`xvideos`, `porntrex`, `vault`, `tango-live`) only
  play.
- **Video Vault** (the `vault` build, iPhone bundle `com.visar.Ptrex.paid`) lists
  both upload sites. It shows only titles that carry the bracketed stamp
  `[YYYY-MM-DD HHMMSS streamer]`, optionally with ` | part N` (`isPipelineUpload`
  in `packages/app/src/providers/uploadSite.ts`). Manual uploads, and uploads
  renamed to the bare stamp, stay on the sites but are not listed.
- **iPhone apps** (`apps/ios`) are WKWebView shells generated from
  `providers.json`. The local apps load `https://192.168.1.197:9999/videos/<provider>`,
  the online apps inject the `packages/app` content build, and the Tango app hosts
  the FC2/SC live extensions.

## 5. Pipeline output: conversion policy

| Constant | Value |
|---|---|
| `CURRENT_PRODUCTION_VERSION` (`domain/productionVersion.ts`) | `production-v6` |
| `RESOLUTION_POLICY_VERSION` | `resolution-policy-v5` |
| `ARTIFACT_RECIPE_VERSION` | `artifact-recipe-v2` |
| artifact file names | `<id>.production-v5[-shapeN][-ccw].mp4` |

- **Input:** edited recordings only, each with an exact `ready` checkpoint for its
  current playlist. Admission records a source fingerprint (the playlist plus each
  file's size and mtime). Every stage and upload checks it again, and a changed
  source stops with "manual re-admission is required". Sources and their
  playlists are never modified; derived playlists are temporary.
- **Every recording is converted, and no segment is dropped.** Nothing is
  stream-copied for upload.
- **Shapes.** Segments are grouped by display aspect ratio (SAR applied, 1%
  tolerance). For fMP4 the last active `#EXT-X-MAP` sets a segment's size; MPEG-TS
  uses one keyframe scan in playlist order that assigns frames to segments by
  packet byte position. One shape is one upload (`full`). Several shapes are one
  upload each (`shape1`, `shape2`, … in order of first appearance), titled
  `… [<folder> | part N]`, uploaded in sequence: the next part is promoted only
  after the previous one verifies.
- **Size.** Each shape is scaled to at least 1920×1080 pixels and at least 1080
  tall, keeping its aspect ratio, and never smaller than its largest source
  picture. No crop, no padding, square pixels; zscale Lanczos, libx264 `slow` CRF
  16, yuv420p, VFR. Audio is copied when the inputs allow it, otherwise re-encoded
  once (AAC 192k).
- **Portrait** pictures are turned 90° counterclockwise (`transpose=2`, head to
  the left) into a landscape frame, and the file name gets `-ccw`. Why: Porntrex
  scales by height, so a portrait upload reaches at most 406×720. The
  counterclockwise test uploads (3353010, 3353057) reached the 1920×1080 tier and
  play upright on an iPhone turned counterclockwise.
- **Imperfect input is kept.** A segment that starts a run without a decodable
  keyframe joins the picture that follows it, and such runs are decoded on their
  own; a run with no picture at all holds the previous frame and keeps its audio.
  Odd TS packet sizes and size changes inside a segment are warnings. Only
  zero-byte files are left out of the encoder input.
- **Short split pieces.** A piece shorter than 60 s
  (`MINIMUM_SPLIT_PIECE_SECONDS`) is not uploaded. It goes to `manual_pieces` and
  is listed by `review`. If no piece is long enough, the recording is blocked.
- **Limits.** An upload over two hours (an operator limit) or over 10 GB
  (Porntrex's limit) is blocked for review. The test uses the artifact's own
  probed duration.
- **Local work without a v5 assessment** in its events is reset and converted
  again. Uploaded and verified recordings are not touched.
- **Artifact cache.** A whole-recording artifact of the current recipe, found in
  an earlier generation's history snapshot, is reused only if its size and SHA-256
  still match. It is hardlinked, or copied exclusively if that fails. Split parts
  are never reused.
- **`remux-one` is a supervised diagnostic.** It stream-copies, or with a flag
  writes `--upscale1080p`/`--upscale1440p` variants to `artifact_variants`. Its
  output has no v5 assessment, so the campaign converts the recording again and
  `upload-one` refuses it.

## 6. Pipeline ledger, campaign and verification

- **Ledger.** `pipeline/pipeline.sqlite` is SQLite in WAL mode with
  `synchronous=FULL`, schema 12. Each state change is one durable transition,
  appended to `state_events`. The `xvideos_*` state names are historical labels
  and apply to every provider.

  ```text
  server_ready → remuxed → artifact_valid → described → metadata_ready → xvideos_admitted
    → xvideos_uploading → xvideos_uploaded → xvideos_verified → cleanup_eligible
  side states: provenance_review_required, xvideos_uncertain, blocked, failed
  ```

- **One worker, one recording at a time.** `video-pipeline.service` runs
  `campaign-worker`. Each step does the first of these that applies:
  1. upload verification that is due (inline);
  2. local stages (convert, validate, describe, compose) of the oldest admitted
     recording;
  3. upload of the oldest `metadata_ready` recording;
  4. admission of the oldest `ready` edited recording not yet in the ledger.

  "Oldest" means the folder-name timestamp, optionally filtered to one provider.
  The worker polls every 30 s when idle and re-reads pause/run intent from
  `campaign_control` at every step. The local-stage lease is 12 h because
  conversion takes about 2.4× the duration and recordings run up to 2 h. All
  leases are cleared at boot.
- **Manual commands defer to the worker.** It writes a heartbeat every 30 s. These
  commands refuse while the heartbeat is under 90 s old, so stop the service first:
  `remux-one`, `describe-one`, `upload-one`, `process-one`, `xvideos-sync`,
  `campaign-prepare`, `campaign-select` and the upload-provider switch.
- **A stuck recording stays in front.** A changed source, a lost checkpoint or a
  missing artifact returns `attention_required` and sends a desktop
  notification. No other recording is substituted.
- **Provenance.** Identifiers are resolved through the server
  (`GET /api/{provider}/resolve`). One the server cannot resolve still uploads,
  with `Source: TODO LATER` in the description. Other unresolved cases wait in
  `provenance_review_required`. `provenance-set` overrides apply to every
  recording with the same identifier.
- **Cooldowns** pause the campaign with `resume_at` while verification keeps
  running. A human-action error (captcha) waits 1, 2, 4 … minutes, capped at 24 h;
  a successful upload or a manual resume resets that streak. `session_login`, the
  XVideos daily limit, or an attempt that failed before submission waits 24 h. A
  lost Porntrex session pauses indefinitely, with `attention_reason` set.
- **Monthly budget.** Uploads are capped at 600,000,000,000 bytes per calendar
  month in `Europe/Tirane`, the upload share of the ISP plan. Admission reserves
  the artifact size plus 16 MiB. Every transmitted byte, including failed and
  retried transfers, goes to `bandwidth_events`, which nothing ever deletes.
- **Success is never decided at submit.** Once metadata may have been submitted,
  the attempt is `xvideos_uncertain` with a confirmation due 24 h later. A failure
  before submission is a plain failure (on Porntrex: before the
  `metadata_submitting` phase, since the video exists only once its form is
  submitted). A started transfer holds a 7-day duplicate-safety window
  (`UPLOAD_RETRY_MILLISECONDS`); an uncertain attempt with no remote ID is requeued
  only after a complete negative lookup past that deadline. A video whose ID
  vanishes from the provider is blocked for review with a desktop notification and
  is re-uploaded only by `retry`.
- **Cleanup is off.** The managed unit sets `VIDEO_PIPELINE_CLEANUP=0`, so
  verified artifacts stay on disk and the source-missing sweep (which needs
  cleanup) does not run. No pipeline command touches source recordings.
- **Review and retry.** `review` lists blocked recordings with reasons,
  unresolved provenance and manual pieces. `retry <ID>` returns a failed or
  blocked recording to the stage it left.
- **Generations.** Each production version owns `pipeline/artifacts/<version>/`
  (supervised variants in `manual/`). The first `campaign-resume --apply` after a
  version change rolls over. It refuses while the campaign runs, a lease exists or
  an upload is in flight. It snapshots the database (fsynced, owner-only) to
  `pipeline/history/<old-version>/`, copies recordings and uploads into the
  `retired_*` tables, clears the active workflow and moves that generation's files
  into its version folder; discovery then restarts from the oldest source.
  Bandwidth events, provenance overrides, rejected phrases, provider inventory and
  campaign configuration survive.
- **Bounded runs exist in code but are inactive** (`trial_per_provider` is null;
  no `comparison_trial` row). `campaign-configure --trial-per-provider N` caps a run
  at N recordings per provider. `campaign-prepare` plus
  `campaign-select --file … --apply` restrict the campaign to listed paths, add version/part diagnostics to
  titles and keep every artifact; the 30 s file watch stays off because
  `comparisonTrialOnly` is hardcoded `false` in `config.ts`.

## 7. Upload providers and sessions

- **One active destination**, `campaign_control.upload_provider`: `porntrex`
  (`xvideos` stays selectable via `upload-provider --provider … --apply`). A switch
  needs a paused campaign, a stopped worker, nothing in flight, no open
  confirmations on the provider being left and, when leaving XVideos, an
  `xvideos-sync` inventory newer than its last upload. Each confirmation is
  verified on the provider its attempt used.
- **Limits** come from `packages/shared/src/uploadPolicy.ts`. The pipeline checks
  each artifact against `policyForUploadProvider(<active>)`.

  | Provider | Visibility | Max duration | Max size |
  |---|---|---|---|
  | Porntrex | public | 2 h (operator limit) | 10 GB |
  | XVideos | private | 2 h | 50 GB |

  `SHARED_UPLOAD_POLICY` and `UPLOAD_PROVIDER_PLAN` (XVideos primary, Bunkr
  unavailable) feed only the server re-export `services/upload/uploadPolicy.ts`,
  which only its tests use.
- **Metadata.** Title: the descriptor title plus ` [<folder>]`, or
  ` [<folder> | part N]` for one shape of a split (max 255 characters).
  Description: the descriptor text, then `Recorded:`, `Source:` and (if known)
  `Alias:` lines (max 1,000). Tags: exactly `[tango|fc2|stripchat, live]`;
  descriptor tags are ignored. Porntrex uploads also get the Webcam category.
- **Remote identity is the bracketed suffix**, used by the duplicate lookup,
  verification and Video Vault. The ledger and captured provider IDs are the
  authority; descriptive titles are never searched. The Porntrex lookup also
  accepts an unbracketed ` <stamp>` ending; a title renamed to the bare stamp is
  outside the identity.
- **No duplicates.** Every Porntrex upload first reads the complete uploads list;
  if the row count does not equal the site's totals, absence is not inferred, and
  any match means no upload. A recording with a copy in a synchronized
  `provider_inventory` is blocked.
- **Porntrex verification.** The edit page must show a published link, and
  ffprobe must find a `/get_file/` rendition of at least 1920×1080×0.995 pixels. A
  video still processing is checked again after 2 h, anything else after 24 h.
  Words Porntrex swapped are learned as rejected phrases. A transfer is abandoned
  only after 10 minutes without progress (`TRANSFER_STALL_MILLISECONDS`).
- **The Porntrex session is shared with the phone**, because Porntrex keeps one
  session per account and the newest login logs the others out. The pipeline
  stores only `PHPSESSID` and `confirmed` in `porntrex-session.json`, pinned for 400
  days, and never presents `kt_member`. The worker checks the session every 10
  minutes without a browser; a logged-out session pauses the campaign with a
  notification and is never logged in again automatically.
  `npm run ptrex:connect-iphone` is the only path that may log in with the password; it
  copies the session into Video Vault over SSH (the Mac runs `devicectl` and the
  WebKit inspector) and resumes the campaign.
- **XVideos:** email/password login in the persistent Chromium profile
  (`~/.config/chromium-agent`); Friendly Captcha gets 60 s to solve automatically;
  the alias is typed into the model search without selecting a model. Verification
  uses the edit page plus a Full-HD rendition in the HLS master.
- **Rejected phrases** are learned per provider (`rejected_phrases`) and appended
  to the description prompt. Composed metadata is checked locally (case-insensitive
  substring) before any byte is sent, and stale text is described again. A refusal
  during upload is definitive and does not start the 7-day hold. `metadata-check`
  is the read-only report.
- **Network gating and browsers.** Real uploads and verification need
  `VIDEO_PIPELINE_NETWORK_UPLOADS=1`, which the managed unit sets. Under
  `VIDEO_PIPELINE_SERVICE_MODE=1` the browser always closes on failure, so it
  never holds the profile lock; interactive commands leave it open.

## 8. Descriptor

- **A library, not a service.** Each `describeArtifact` call starts and stops
  `llama-server` (the `VisarDomi/llama.cpp` CUDA fork) with
  `gemma-4-E4B-OBLITERATED-Q8_0.gguf` and an F16 mmproj, context 131,072, port
  7976. Startup may take `DESCRIPTOR_STARTUP_TIMEOUT_MS` (10 min), polled with 2 s
  health requests; an occupied port is refused. `DESCRIPTOR_MODEL_URL` selects an
  external server instead.
- **Output** is a title (5–100 characters) and a description (20–750), for the
  exact validated artifact that will be uploaded.
- **Frame rate:** at most 4 FPS below 7 minutes, 2 FPS below 15 minutes, 1 FPS
  beyond; a 115,000-token video budget at 70.5 tokens per frame lowers FPS further
  for long videos. Why: in measured comparisons, 1 FPS kept the useful detail at
  about a quarter of the tokens of 4 FPS, and 4 FPS showed no consistent gain.
- **Upright copies.** For `-ccw` artifacts the pipeline passes
  `rotation: "clockwise"`, so the model sees the picture upright. Why: shown
  sideways frames, the model describes people as lying down.
- **Evidence** is cached at
  `pipeline/descriptions/artifacts/<artifact sha256>/<prompt hash>[-clockwise]/result.json`.
  The prompt hash includes the learned phrases. The same artifact with the same
  prompt is never described twice, even across generations; rollover leaves this
  evidence in place.

## 9. Operations

- **Units** are versioned in `systemd/user`. `npm run systemd:sync` expands
  `{{HOME}}`, writes changed files by temp file and rename, and runs
  `daemon-reload`; it never starts, stops, enables or disables anything.
  `npm run systemd:check` reports drift.

  | Unit | Settings |
  |---|---|
  | `video-processing.slice` | `CPUQuota=600%`, `MemoryHigh=70%`, `MemoryMax=80%`, `MemorySwapMax=0` |
  | `video-server.service` | in the slice, `CPUWeight=1000` |
  | `video-pipeline.service` | in the slice, `CPUWeight=100`; `DISPLAY=:111`, `NETWORK_UPLOADS=1`, `CLEANUP=0`, `SERVICE_MODE=1` |
  | `video-finalize-library-single` scope | `CPUWeight=1000` |
  | `video-auth.service`, `video-downloader.service` | outside the slice |
  | `video-xvfb.service` | `Xvfb :111` for headful Chromium; others use only `After=`, so enable it explicitly |

  There is no timer unit.
- **systemd owns CPU allocation; the code only exposes parallel work.** FFmpeg
  gets no thread, priority or load flags (tests enforce this). Parallelism comes
  from the cgroup-aware `os.availableParallelism()`: 6 under the 600% quota on the
  12-CPU host. Manual heavy commands join the slice as transient scopes
  (`systemd-run --user --scope --slice=video-processing.slice`):
  `video-finalize-library[-single]`, `video-pipeline-remux-one`,
  `video-pipeline-describe-one`, `video-descriptor-<pid>`. Live finalization and
  the API win under contention without keeping background work off idle CPU. The
  slice does not bound the descriptor's GPU use.
- **Builds.** `npm run start:*` and `restart:*` build the core services and start
  them; they run prebuilt `dist/` through the `~/.local/bin/video-*` wrappers. The
  pipeline service rebuilds (`rm -rf dist && tsc`) on every start.
- **Logs** go only to journald (winston console output or JSON lines). Read them
  with `npm run logs:*` or `journalctl --user -u <unit>`. The code has no log
  directory and no rotation.
- **Notifications.** The managed pipeline worker uses `notify-send` for attention,
  cooldowns, provider removals and lost sessions, never repeating a message within
  6 h; `VIDEO_PIPELINE_NOTIFY=0` silences it.
- **Auth** serves Tango only. Stream tokens refresh every 5 s and the session
  every 30 min. A Google OAuth login in headful Chromium on `:111` happens only
  when the refresh token is missing or rejected. `readTokens()` reads one fixed
  account file.
