# Video Platform

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
