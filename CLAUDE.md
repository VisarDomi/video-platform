# Video Platform

Monorepo. 5 packages: app (Svelte 5 SPA), server (Express, port 7973), downloader (stream capture, port 7974), auth (token refresh daemon), shared (HLS utils).
Sibling repo: `~/Documents/wip/video-repos/video-descriptor/` (frame analysis + AI descriptions, port 7975).

Providers: tango, fc2, sc, tl (ephemeral, /tmp), mp4.
Systemd user services: video-server, video-downloader, video-auth, video-descriptor.

## Docs

Before debugging HLS or playback issues, read `packages/app/docs/`:
- `tl-hls-proxy.md` — HLS proxy architecture, epoch counter pattern, cross-provider state pollution fix
- `svelte5-reactivity-lessons.md` — reactive loop debugging, anti-pattern catalog
- `virtual-scroll-ios.md` — native window scroll virtualization for iOS
- `pwa-native-swipes.md` — gesture state machine, 3-player carousel, edge-back animation

