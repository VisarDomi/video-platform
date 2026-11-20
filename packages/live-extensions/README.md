# Safari extensions

Safari web extensions for the phone, built from the plug-ins of a deployment's sites file
(`$VIDEO_SITES_FILE`, else `<data root>/sites.json`). The iPhone app that hosts them is
the deployment's own; this package builds their files.

- **Download-list bars**, one per enabled site whose plug-in declares one: on a streamer's
  page a fixed top bar with the website viewer's +/- button (it imports
  `DownloadListButton` and `buttons.css` from the `app` workspace, inside a shadow root so
  the site's styles and the button's stay apart). The plug-in's `extension.json` names
  the pages and its page code, which exports the `adapter` that reads the streamer from
  the URL (and, for a `document_start` script, `onDocumentStart()`). This package keeps
  the bar (`src/core/downloadListBar.ts`), the background page that talks to the PC
  (`src/extension/background.ts`, `/api/<site>/member|add|remove`, so page security
  policies never apply) and the manifest.
- **Send-to-PC extensions**, one per file host of the sites file (`fileHosts`) whose
  plug-in declares one (`kind: "send-to-pc"`): the plug-in brings its content script and
  background page; the build gives them the PC's file-host service (`:9998`) and the
  host's API path, `/api/<host>` (see `packages/server/src/fileHosts.ts`).

The sites file's `extensions` block names the PC (`"pc"`, e.g. `https://192.168.1.10`;
the list server is on `:9999`) and the hosting app (`"hostApp"`, in the descriptions).

## Build

```bash
npm run build -w live-extensions            # every extension the sites file declares
npm run check -w live-extensions            # type check
```

The build writes `manifest.json`, `content.js` and `background.js` to
`dist/extension/<key>/` at the repository root. Each extension needs enabling once in
Safari's extension settings, with its site allowed.
