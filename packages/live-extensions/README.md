# Live download-list extensions

Safari web extensions that add or remove the open streamer from a PC download
list: **LADDER live** (`ladder-live.example`, `/api/ladder`) and **FMP4 live** (`fmp4-live.example`,
`/api/fmp4`). They are hosted by the TsLive app (`apps/ios`, provider `tslive-live`).
See `notes.md` for the layout.

The server URL is `SERVER` in `src/core/config.ts` (`https://192.168.1.197:9999`).

## Build

```bash
npm run build -w live-extensions            # both extensions
npm run check -w live-extensions            # type check
```

The build writes `manifest.json`, `content.js`, and `background.js` to
`dist/extension/ladder-live/` and `dist/extension/fmp4-live/` at the repository root.
`apps/ios/scripts/deploy.py tslive-live sync` builds both and stages them into the
TsLive app's `LADDERLive` and `SCLive` extension targets.
