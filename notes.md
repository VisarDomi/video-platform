# agent notes

Monorepo. Packages: `app` (TypeScript frontend, also the online iPhone apps' content scripts), `server` (Express, HTTPS port `9999`), `downloader` (stream capture), `auth` (token refresh daemon), `shared` (cross-package policy/HLS utilities), `descriptor` (local native-video description engine), `pipeline` (durable processing and upload campaign), and `live-extensions` (the FC2 live and SC live Safari extensions hosted by the Tango iPhone app: download-list controls for fc2/sc; built with esbuild).

Recording providers: `tango`, `fc2`, `sc`.
Systemd user services: `video-server`, `video-downloader`, `video-auth`, `video-pipeline` (campaign worker; idles while the campaign is paused), and `video-xvfb` (persistent virtual display `:111` for the auth and pipeline Chromium). Upload verification runs inline in the campaign worker; there is no reconcile timer and no descriptor unit. `video-processing.slice` bounds the server's and pipeline's processing.

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
- iPhone apps:
  `~/Documents/work/video/video-platform/apps/ios/`

## Frontend - no restarting
npm run build:app

The server serves `packages/app/build` directly, so the website and the local iPhone
apps pick up a build without a restart. Video Vault and Tango bundle their content
script and need a deploy (`apps/ios/PORT.md`).

## others - depends
check package.json

# setup

## iPhone apps

Five iPhone apps share one host (`apps/ios`): **Tango local**, **FC2 local** and
**SC local** open the website's provider tabs; **Video Vault** lists the pipeline's
XVideos and Porntrex uploads; **Tango** shows live streams on tango.me. Their videos play
in a native viewer that keeps playing through lock and the background, so player changes
need an app deploy; the local apps' lists still come from the website. They are built
on the Mac (SSH from this PC); the phone is cabled to the Mac. Build, deploy, inspection
and renewal are in [`apps/ios/PORT.md`](apps/ios/PORT.md).

## Data outside the repository

Nothing the services need lives in the checkout, so deleting and re-cloning it loses
nothing (only logs and diagnostic screenshots stay in package folders):

- `~/.local/share/video-services/`: the download lists (below), Tango sessions
  (`session/`), aliases, finalization and pipeline databases, pipeline artifacts,
  descriptor models and runtimes, live status.
- `~/.config/video-services/` (files mode 600): `auth-accounts.json` (the accounts
  `video-auth` keeps signed in; `VIDEO_AUTH_ACCOUNTS_FILE` overrides),
  `upload-providers.json` (XVideos/Porntrex upload logins) and `porntrex-session.json`.
- `~/.config/chromium-agent/`: the pipeline's Chromium profile.
- `~/.local/share/mkcert/pwa/`: the server's HTTPS certificate (without it the server
  falls back to HTTP).
- `~/Videos/downloads/<provider>/{downloaded,edited,trash}`: recordings
  (`VIDEO_DOWNLOADS_ROOT` overrides).

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
