# Live download-list extensions

Two Safari web extensions hosted by the Tango app (`apps/ios`): **FC2 live**
(live.fc2.com) and **SC live** (stripchat.com). On a streamer's page each shows a
fixed top bar with a "+ Add / - Remove" toggle for the PC download list. Tango's
own list control is in the shared viewer (`packages/app`, provider `tango-live`).

## Layout

- `src/core/downloadListBar.ts`: the one shared bar; providers only classify routes
  (`src/provider/fc2-live.ts`: numeric ID; `sc-live.ts`: username, skipping
  non-streamer pages).
- `src/extension/<name>.ts` is each content script; `background.ts` performs the
  PC requests (`https://192.168.1.197:9999/api/<fc2|sc>/list|add|remove`), only
  for its own provider, so page security policies never apply.
- `npm run build -w live-extensions` writes `dist/extension/fc2-live` and
  `dist/extension/sc-live` (manifest, content.js, background.js); the Tango app's
  `scripts/deploy.py tango-live sync` builds and stages them.

These replaced the earlier Tampermonkey userscript (October 2026).
