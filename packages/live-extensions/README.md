# Live download-list extensions

Safari web extensions that add or remove the open streamer from a PC download
list: **FC2 live** (`live.fc2.com`, `/api/fc2`) and **SC live** (`stripchat.com`,
`/api/sc`). They are hosted by the Tango app (`apps/ios`, provider `tango-live`).
See `notes.md` for the layout.

The server URL is `SERVER` in `src/core/config.ts` (`https://192.168.1.197:9999`).

## Build

```bash
npm run build -w live-extensions            # both extensions
npm run check -w live-extensions            # type check
```

The build writes `manifest.json`, `content.js`, and `background.js` to
`dist/extension/fc2-live/` and `dist/extension/sc-live/` at the repository root.
`apps/ios/scripts/deploy.py tango-live sync` builds both and stages them into the
Tango app's `FC2Live` and `SCLive` extension targets.
