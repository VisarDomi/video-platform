# stream-viewer

A lightweight userscript that makes exploring live streams easy.

## What?
This script changes the UI of the providers supported by this script so that's it easier to watch streams. Features:
1. show list of favorites and recommended.
2. show streams in tiktok style: swipe to go to next/prev stream

## Why?
Native navigation is cumbersome and too resource intensive and wastes phone battery.

## How?
[flow.md](flow.md) explain the flows that this app handles best.

## Supported providers

```
tango.me
```

## Safari extension

Stream Viewer is also an independent Safari Web Extension inside the shared
**Reader Extensions** iOS app. Gallery Reader, KM Explorer and Stream Viewer
remain separate extensions with separate permissions and bundles.

```sh
npx tsc --noEmit
npm run build:extension
npm run tests:extension
```

Build output is `dist/extension/{manifest.json,content.js}`. The shared iOS Xcode
host is in `../../manga/gallery-reader/extension/apple/`; run `npm run build:extensions`
in Gallery Reader to stage all three bundles before building/installing that host.
The Stream Viewer extension ID is `com.visar.galleryreader.extensiontest.StreamViewer`.

Enable Stream Viewer in Settings → Apps → Safari → Extensions and allow
`tango.me`/`www.tango.me`. Disable its Userscripts version while using the extension.
The extension uses the same Tango origin storage, cookies, session refresh,
download-list server, routes and gestures. No account data is migrated or cleared.
If a new login is needed, temporarily disable the extension to use Tango's login
page, then re-enable and refresh.

`src/main.ts` remains the userscript entry point. `extension/main.ts` validates
the provider, guards repeated document-start injection, and calls the same app
modules. Only the extension build replaces open/close with DOM replacement
after `window.stop()`. The shell explicitly creates its head/body and viewport
because it can run before Tango creates them. Injection is MAIN-world,
document-start, top-frame, and limited to the two Tango hosts. No background
extension process, extra UI or request-interception policy was introduced.
This does not promise that no original-site bytes or scripts ever run.

Both builds use the same three-video scroll behavior: midpoint selection keeps
the playing element in place without programmatic scrolling during momentum.
On `scrollend`, with no added delay and no finger down, a blank-spacer landing
snaps to just the next/previous
entry in the scroll direction (or stays at the list boundary). There is no
distance-based jump through the stream list.

## [Testing](test.md)
The userscript-injection test harness and native extension checks are described
in [test.md](test.md). The live action suite changes account data; do not run it
as an ordinary extension smoke test.

## Manual maintenance

`scripts/tango-unblock-blocklist.mjs` is a standalone account-maintenance utility,
not part of either app or its tests. It reads the PC's existing Tango session and
defaults to a dry run; `--execute` unblocks **every** account on the blocklist.
Do not use it for routine validation or cleanup.
