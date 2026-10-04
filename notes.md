# agent notes

Monorepo. Packages: `app` (TypeScript frontend), `server` (Express, port `9999`), `downloader` (stream capture, port `7974`), `auth` (token refresh daemon), `shared` (cross-package policy/HLS utilities), `descriptor` (local native-video description engine), `pipeline` (durable processing foundation), and `userscripts` (browser download-list controls for fc2/sc; built with Vite + vite-plugin-monkey).

Providers: `tango`, `fc2`, `sc`.
Systemd user services: `video-server`, `video-downloader`, `video-auth`, `video-pipeline` (campaign worker; idles while the campaign is paused), and `video-xvfb` (persistent virtual display `:111` for pipeline Chromium). Upload verification runs inline in the campaign worker; the old `video-reconcile.timer` (daily 04:33) and the old `video-descriptor` unit were removed; do not recreate either.

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

## Frontend - no restarting
npm run build:app

## others - depends
check package.json

# setup

## iPhone apps

**Tango local**, **FC2 local** and **SC local** are the three provider tabs as iPhone
apps (`apps/ios`); build, deploy and renewal are in [`apps/ios/PORT.md`](apps/ios/PORT.md).

## Data outside the repository

Nothing the services need lives in the checkout, so deleting and re-cloning it loses
nothing (only logs and diagnostic screenshots stay in package folders):

- `~/.local/share/video-services/`: the download lists (below), Tango sessions
  (`session/`), aliases, finalization and pipeline databases, live status.
- `~/.config/video-services/` (private, mode 600): `auth-accounts.json` (the accounts
  `video-auth` keeps signed in; `VIDEO_AUTH_ACCOUNTS_FILE` overrides),
  `upload-providers.json` (XVideos/Porntrex upload logins) and `porntrex-session.json`.
- `~/Videos/downloads/<provider>/`: recordings.

## Download lists

The download lists (which streamers to record):

- `~/.local/share/video-services/download-lists/tango.txt`: `https://tango.me/<accountId> <alias>`
- `~/.local/share/video-services/download-lists/fc2.txt`: `https://live.fc2.com/<channelId>/`
- `~/.local/share/video-services/download-lists/sc.txt`: `https://stripchat.com/<username> <roomId>`

`VIDEO_SERVICES_DATA_ROOT` moves the whole data folder (`downloadListPath` in
`packages/shared`). The server edits the lists (the +/- buttons, `POST /api/<provider>/add`);
the downloader watches them and creates a missing one with a comment line.
