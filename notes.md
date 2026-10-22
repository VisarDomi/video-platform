# agent notes

Monorepo. Packages: `app` (TypeScript frontend: the local website; the iPhone apps in `apps/ios` are native), `server` (Express, HTTPS port `9999`), `downloader` (stream capture), `auth` (token refresh daemon), `shared` (cross-package policy/HLS utilities), `descriptor` (local native-video description engine), `pipeline` (durable processing and upload campaign), and `live-extensions` (the FC2 live and SC live Safari extensions hosted by the Tango iPhone app: download-list controls for fc2/sc; built with esbuild).

Recording providers: `tango`, `fc2`, `sc`.
Systemd user services: `video-server`, `video-downloader`, `video-auth`, `video-pipeline` (campaign worker; idles while the campaign is paused), and `video-xvfb` (persistent virtual display `:111` for the auth and pipeline Chromium). Upload verification runs inline in the campaign worker; there is no reconcile timer and no descriptor unit. `video-processing.slice` bounds the server's and pipeline's processing.
`video-ptrex-session.timer` maintains the shared phone session every ten minutes even
while the upload worker is stopped. It makes one cookie-only request, skips a live worker,
and never logs in, launches processing or changes campaign intent.

The monorepo owns its systemd user configuration under `systemd/user/`. Keep
the installed copies synchronized with `npm run systemd:check` and
`npm run systemd:sync`; do not maintain divergent chezmoi copies. Syncing
reloads systemd but deliberately does not restart services.

## Read

- Decisions:
  `~/Documents/work/video/video-platform/decisions.md`

## Logs

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
- FC2 live / SC live extensions:
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

Five iPhone apps share one host (`apps/ios`): **Tango local**, **FC2 local** and
**SC local** list the PC's recordings; **Video Vault** lists the pipeline's Porntrex uploads; **Tango** shows live streams on tango.me. All five are native lists with
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
