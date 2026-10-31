# agent notes

Monorepo. Packages: `app` (TypeScript frontend: the local website; the iPhone apps in `apps/ios` are native), `server` (Express, HTTPS port `9999`, plus the independent Bunkr queue on `9998`), `downloader` (stream capture), `auth` (token refresh daemon), `shared` (cross-package policy/HLS utilities), `descriptor` (local native-video description engine), `pipeline` (durable processing and upload campaign), and `live-extensions` (Safari extensions hosted by Tango: FC2/SC download-list controls and Bunkr downloads to the PC; built with esbuild).

Recording providers: `tango`, `fc2`, `sc`.
Systemd user services: `video-server`, `video-downloader`, `video-auth`, `video-pipeline` (campaign worker; idles while the campaign is paused), `video-bunkr-downloads` (independent durable byte-copy queue on HTTPS :9998), and `video-xvfb` (persistent virtual display `:111` for the auth and pipeline Chromium). Upload verification runs inline in the campaign worker; there is no reconcile timer and no descriptor unit. `video-processing.slice` bounds the server's and pipeline's processing.
`video-ptrex-session.timer` maintains the shared phone session every ten minutes even
while the upload worker is stopped. Healthy checks are cookie-only. Confirmed sign-outs
are repaired through one coordinated PC/phone recovery; valid phone copies are reused
first. Failed delivery is retried without another login. It never starts processing or
changes campaign intent, and coordinates with a live worker through a recovery lock.

The monorepo owns its systemd user configuration under `systemd/user/`. Keep
the installed copies synchronized with `npm run systemd:check` and
`npm run systemd:sync`; do not maintain divergent chezmoi copies. Syncing
reloads systemd but deliberately does not restart services.

## Read

- Decisions:
  `~/Documents/work/video/video-platform/decisions.md`

## Logs

- The current Internet download cap is **10 Mbps** (owner confirmed 2026-10-31).
  Preserve the highest-quality source bytes and keep missed-segment accounting
  accurate; bandwidth-constrained gaps are still counted as `missed_ours` when
  logged as late polls. Do not add parallel requests or change capture quality
  to conceal the cap. The owner plans to contact the ISP next month; that is
  context, not a scheduled reminder or authorization to contact anyone.
- Hourly babysitting uses `python3 scripts/babysit_ledger.py` for newly committed
  upload submissions, verification receipts and provider removals. Reconciliation
  can commit results after a report snapshot with the batch's earlier timestamp,
  so a timestamp-only window can miss them. The helper reads one SQLite snapshot
  without modifying it; save its `next_cursors` as `ledger_cursors` in
  `~/.local/share/video-services/babysit/monitoring.json` only after the full report
  succeeds. Without cursors it explicitly bootstraps from the previous window
  (or `--since`); a production rollover rebaselines the counters. Run tests with
  `python3 -m unittest discover -s scripts -p 'test_babysit_ledger.py'`.
- Start debugging by checking the managed service logs.
- Use direct `journalctl` for bounded reads:
  `journalctl --user -u video-server.service -u video-downloader.service -n 300 --no-pager`
- Only warnings and errors: add `-p warning`. The routine detail is not logged by default;
  run a service with `LOG_LEVEL=debug` (e.g. `systemctl --user set-environment LOG_LEVEL=debug`
  before restarting it, `unset-environment` afterwards) to see per-poll and per-retry lines.
- For a time window, usually the specific time after a build so that you get the logs from the user tests:
  `journalctl --user -u video-server.service -u video-downloader.service --since '2026-05-11 10:54:30' --until now --no-pager`

## Routes

- App frontend:
  `~/Documents/work/video/video-platform/packages/app/`
- Server/API details:
  `~/Documents/work/video/video-platform/packages/server/`
- Downloader details:
  `~/Documents/work/video/video-platform/packages/downloader/`
- Descriptor details:
  `~/Documents/work/video/video-platform/packages/descriptor/`
- Pipeline details:
  `~/Documents/work/video/video-platform/packages/pipeline/`
- Auth (Tango session) details:
  `~/Documents/work/video/video-platform/packages/auth/`
- FC2 live / SC live / Bunkr to PC extensions:
  `~/Documents/work/video/video-platform/packages/live-extensions/`
- iPhone apps:
  `~/Documents/work/video/video-platform/apps/ios/`

## Frontend - no restarting
npm run build:app

The server serves `packages/app/build` directly, so the website picks up a build without a
restart. The iPhone apps are native and need a deploy (`apps/ios/README.md`).

## others - depends
check package.json

# setup

## iPhone apps

Six iPhone apps share one host (`apps/ios`): **Tango local**, **FC2 local** and
**SC local** list the PC's recordings; **Bunkr local** plays the PC's completed MP4s; **Video Vault** lists the pipeline's Porntrex uploads; **Tango** shows live streams on tango.me. All six are native lists with
a native viewer that keeps playing through lock and the background, so any change to them
needs an app deploy. They are built on the Mac (SSH from this PC); the phone is paired
with the Mac over Wi-Fi. Build, deploy, tests, inspection and renewal are in
[`apps/ios/README.md`](apps/ios/README.md).

## Data outside the repository

Nothing the services need lives in the checkout, so deleting and re-cloning it loses
nothing (only logs and diagnostic screenshots stay in package folders):

- `~/.local/share/video-services/`: the download lists (below), Tango sessions
  (`session/`), aliases, finalization and pipeline databases, pipeline artifacts,
  descriptor models and runtimes, live status, and the Tango phone key
  (`tango-phone-key`, made once by `apps/ios/scripts/deploy.py tango-live sync`).
- `~/.config/video-services/` (files mode 600): `auth-accounts.json` (the accounts
  `video-auth` keeps signed in; `VIDEO_AUTH_ACCOUNTS_FILE` overrides),
  `upload-providers.json` (Porntrex credentials) and `porntrex-session.json`.
- `~/.config/chromium-agent/`: the pipeline's Chromium profile.
- `~/.local/share/mkcert/pwa/`: the server's HTTPS certificate (without it the server
  falls back to HTTP).
- `~/Videos/downloads/<provider>/{downloaded,edited,trash}`: recordings
  (`VIDEO_DOWNLOADS_ROOT` overrides).
- `~/Videos/plab/bunkr/`: original Bunkr downloads requested in Safari through
  Tango's **Bunkr to PC** extension (`.si`, `.ph`, `.cr`). The server owns this
  separate durable queue and Bunkr local's MP4 library on HTTPS :9998, with job/checkpoint files in
  `~/.local/share/video-services/bunkr-downloads/`; it does not enter the upload
  pipeline. See `packages/live-extensions/README.md` for power-loss recovery.
- `~/.local/share/video-services/bunkr-library/index.json`: disposable MP4 duration/stat
  metadata for Bunkr local. The actual MP4 directory remains the library authority.
- `~/Desktop/video-pipeline/{move-conversions,move-recordings}`: files staged by
  the two manual cleanup commands, with review CSVs and move journals. They are
  still on disk until the user deletes them. See
  [manual cleanup](packages/pipeline/setup.md#move-files-to-the-desktop-for-manual-deletion).

## Download lists

The download lists (which streamers to record):

- `~/.local/share/video-services/download-lists/tango.txt`: `https://tango.me/<accountId> <alias>`
- `~/.local/share/video-services/download-lists/fc2.txt`: `https://live.fc2.com/<channelId>/`
- `~/.local/share/video-services/download-lists/sc.txt`: `https://stripchat.com/<username> <roomId>`

`VIDEO_SERVICES_DATA_ROOT` moves the download lists (`downloadListPath` in
`packages/shared`) and the pipeline's and descriptor's data; Tango sessions, aliases,
live status and the server's finalization database stay in
`~/.local/share/video-services/`. The server edits the lists (the +/- buttons,
`POST /api/<provider>/add|remove`); the downloader watches them and creates a missing
one with a comment line.
