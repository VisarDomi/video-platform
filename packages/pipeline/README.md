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
- Server-delegated per-provider identity resolution through
  `GET /api/{provider}/resolve` (Tango alias registry + live Tango API, FC2
  numeric IDs, Stripchat username lookup), grouped unresolved review, and
  reusable manual overrides.
- XVideos-safe metadata composition with deterministic reconciliation keys,
  provenance suffixes, provider/live defaults, and normalized tag deduplication.
- Persistent-Chromium XVideos upload through Google OAuth, automated
  Friendly Captcha completion with a manual fallback, streamer alias typed
  into the model search without selection, fixed metadata policy, and 24-hour
  edit-page verification.
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
observed folder alias. Resolution asks the API server (default
`https://127.0.0.1:7973`, override with `VIDEO_SERVER_URL`) instead of
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

`model:set` still stores per-streamer model details for future use, but the
upload no longer requires them:

```bash
npm run model:set -w pipeline -- RECORDING_ID --from-env
```

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

No systemd unit is installed yet. The private worker loop is ready for the
future managed service, which will start at boot and idle while SQLite says
paused. Do not activate it until finalization, descriptor, uploader, and
retention decisions are complete.

Failures retain their last successful stage. Retry an eligible local failure:

```bash
npm run retry -w pipeline -- RECORDING_ID
```
