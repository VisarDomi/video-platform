# Local provider apps

**Tango local**, **FC2 local** and **SC local** are the three Safari tabs for the
PC's video library, as iPhone apps. Each opens its provider's page on the PC and
nothing else:

| Provider | App | Bundle ID | Start URL |
| --- | --- | --- | --- |
| `tango` | Tango local | `com.visar.TangoLocal.paid` | `https://192.168.1.197:9999/videos/tango` |
| `fc2` | FC2 local | `com.visar.FC2Local.paid` | `https://192.168.1.197:9999/videos/fc2` |
| `sc` | SC local | `com.visar.SCLocal.paid` | `https://192.168.1.197:9999/videos/sc` |

`providers.json` is the registry. One Swift host (`LocalVideos/`) serves all three;
`scripts/project.py <provider>` generates that provider's project and Info.plist.
This follows Gallery Reader's provider apps. They are not related to the live
**Tango** app (`com.visar.Tango.paid`, stream-viewer) or its Xvid/Ptrex extensions.

## Behavior: 1:1 with Safari

- The page, API, +/- list buttons and HLS come from the PC exactly as in Safari.
  No website code is bundled: deploying the website updates the apps too.
  The phone already trusts the PC's mkcert root, so there is no custom TLS code.
- Navigation is limited to the start URL and its subpaths on the PC
  (`LocalVideos/Policy.swift`); other providers, the API root and other hosts
  are blocked.
- Like a restored Safari tab, a killed app reopens the page you were on with its
  Back/Forward list (WebKit `interactionState`, saved on page load, resign and
  background). WebKit decides scroll restoration.
- Edge-swipe Back/Forward, pinch zoom, inline playback, Safari's portrait and
  landscape orientations, and pull-down reload. When the PC is unreachable a
  "Can't reach your PC" message with Retry replaces Safari's error page.
- Watch progress and highlights live in each app's own WebKit storage; they are
  not shared with Safari. No icon, launch artwork, entitlements, background
  refresh or offline list.

## Build, deploy and inspect

Start with [shared Mac access](/home/visar/Documents/environment/mac-access.md).
Mac mirror: `/Users/visar/Developer/video-platform/apps/ios`. Phone:
`00008101-000639912881401E`; paid team `65U58U86DD`. From this folder:

```sh
python3 scripts/deploy.py <provider> sync
python3 scripts/deploy.py <provider> test      # policy tests on the Mac
python3 scripts/deploy.py <provider> build     # attached GUI session, signing lock
python3 scripts/deploy.py <provider> status
python3 scripts/deploy.py <provider> install   # verifies, installs over, launches
```

`install` checks bundle ID, display name, start URL, icon absence, signature, paid
team, phone provisioning and expiry before replacing the same app. Never uninstall
to update. No LaunchAgent is created; pause only the idle monthly scheduler before
changing an approved baseline. Physical checks use
`scripts/app-inspector.py --bundle <bundle ID>` with the Mac's existing
`gallery-reader-extension/inspector-venv` Python while the app is in the foreground.

## Renewal

Reader Extensions' `configure-refresh.py --video-root
/Users/visar/Developer/video-platform/apps/ios` describes the three monthly entries
`tango-local`, `fc2-local` and `sc-local`. Their inputs are `LocalVideos`,
`providers.json`, `scripts/project.py` and `scripts/build-provider.py`. On the Mac
only those three configs were added to the existing index; do not regenerate the
whole index, because the manga apps' deployed configs differ from the generator.
After a change: pause the idle scheduler, deploy, approve each changed app, verify
renewal and resume. See `verification.json`.
