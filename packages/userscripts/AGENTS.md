# Video Platform Userscripts

This subtree owns the browser userscripts that act as remote controls for the
video platform download lists.

## Layout

- One bundle (`video-platform.user.js`) with provider modules inside — the
  same provider pattern as the standalone manga-reader repo. The site's host
  decides which adapter runs at runtime.
- `src/core/downloadListBar.ts` is the single shared bar implementation
  every provider uses; providers only define their route classification.
- Providers: `fc2` (live.fc2.com) and `sc` (stripchat.com). Tango's
  download-list control lives in the separate stream-viewer repo — do not
  duplicate it here.

## Rules

- The server URL is build-configurable (`VITE_VIDEO_SERVER_URL`), default
  `https://192.168.1.197:7973`. Never hardcode a second URL elsewhere.
- Build with `npm run build -w userscripts`; the output for Tampermonkey is
  `packages/userscripts/dist/video-platform.user.js`.
