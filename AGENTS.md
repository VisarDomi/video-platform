# Video Platform

Monorepo. Packages: `app` (Svelte SPA), `server` (Express, port `7973`), `downloader` (stream capture, port `7974`), `auth` (token refresh daemon), `shared` (HLS utils), `dashboard` (Svelte frontend, port `7976`).

Sibling repo: `~/Documents/work/video/video-descriptor/` (frame analysis + AI descriptions, port `7975`).

Providers: `tango`, `fc2`, `sc`.
Systemd user services: `video-server`, `video-downloader`, `video-auth`, `video-dashboard`, `video-descriptor`.

## Read

- Decisions:
  `~/Documents/work/video/video-platform/decisions.md`

## Routes

- App frontend:
  `~/Documents/work/video/video-platform/packages/app/`
- Dashboard frontend:
  `~/Documents/work/video/video-platform/packages/dashboard/`
- Server/API details:
  `~/Documents/work/video/video-platform/packages/server/`
- Downloader details:
  `~/Documents/work/video/video-platform/packages/downloader/`
