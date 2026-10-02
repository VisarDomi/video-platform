# userscripts

Browser userscripts that act as remote controls for the video platform
download lists.

- One bundle (`video-platform.user.js`), provider modules inside (like
  manga-reader): the site's host decides which provider adapter runs.
- Providers: `fc2` (live.fc2.com) and `sc` (stripchat.com). Each adds a
  fixed top bar with a "+ Add / - Remove" toggle that drives the server's
  `/api/{provider}/list|add|remove` endpoints.
- Server URL: `https://192.168.1.197:9999` by default; override at build
  time with `VITE_VIDEO_SERVER_URL`.

## Build

```bash
npm run build -w userscripts     # emits packages/userscripts/dist/video-platform.user.js
```

Install `dist/video-platform.user.js` in Tampermonkey.

# Other userscript
the third provider is at:

https://github.com/VisarDomi/stream-viewer
