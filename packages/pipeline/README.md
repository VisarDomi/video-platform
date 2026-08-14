# Durable video pipeline

This package owns the months-long per-recording processing queue. It remains
separate from Express and is not installed as a systemd service yet.

Implemented:

- SQLite WAL/FULL recording state, transition events, leases, artifact hashes,
  description evidence, provenance, metadata, streamer-model mappings, upload
  attempts, transmitted-byte accounting, and remote-entry evidence.
- Production discovery of only exact server-checkpointed `editor/edited`
  recordings. Hidden handoff directories and raw downloader recordings are
  excluded from campaign processing.
- One-recording stream-copy remux, full decode/probe, SHA-256 evidence, and
  exact-artifact description.
- Shared target resolution with Tango API alias history, current FC2/Stripchat
  identities, grouped unresolved review, and reusable manual overrides.
- XVideos-safe metadata composition with deterministic reconciliation keys,
  provenance suffixes, provider/live defaults, and normalized tag deduplication.
- Persistent-Chromium XVideos upload through Google OAuth, explicit CAPTCHA
  pauses, supervised model selection/creation, fixed metadata policy, and
  authenticated uploads-list reconciliation.
- Calendar-month upload admission capped at 600,000,000,000 bytes in
  `Europe/Tirane`, restart recovery, and a 24-hour no-retry confirmation window
  after metadata submission may have succeeded.
- Source/artifact cleanup hard-disabled.

Production activation is still blocked until the historical finalization
contract completes, descriptor output is approved, and one controlled upload
saves metadata and validates the final submission/reconciliation boundary.
The temporary-MP4 retention policy is also intentionally undecided. Network
access is disabled by default and there is no pipeline service.

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
observed folder alias:

```bash
npm run provenance:refresh -w pipeline
npm run provenance:review -w pipeline
```

One manual override applies to every matching recording:

```bash
npm run provenance:set -w pipeline -- RECORDING_ID \
  --streamer-id ID --alias NAME --streamer-url URL --alias-url URL
```

Configure the resolved streamer's model. `--from-env` applies values only to
this explicit streamer; those values are not global defaults:

```bash
npm run model:set -w pipeline -- RECORDING_ID --from-env
```

During supervised `upload-one`, the browser searches that stage name and then
waits. It never selects a suggestion by name. Choose the correct result
manually, or click create; when the creation form opens, the configured details
and picture are filled and the command waits for you to review/submit. The
future unattended campaign requires a confirmed stored XVideos model ID.

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

No systemd unit is installed yet. The private worker loop is ready for the
future managed service, which will start at boot and idle while SQLite says
paused. Do not activate it until finalization, descriptor, uploader, and
retention decisions are complete.

Failures retain their last successful stage. Retry an eligible local failure:

```bash
npm run retry -w pipeline -- RECORDING_ID
```
