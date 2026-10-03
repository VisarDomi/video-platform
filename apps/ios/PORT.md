# Provider apps

Five iPhone apps share one Swift host (`VideoApp/`), following Gallery Reader's
provider apps. `providers.json` is the registry; `scripts/project.py <provider>`
generates that provider's project and Info.plist.

| Provider | App | Bundle ID | Start URL |
| --- | --- | --- | --- |
| `tango` | Tango local | `com.visar.TangoLocal.paid` | `https://192.168.1.197:9999/videos/tango` |
| `fc2` | FC2 local | `com.visar.FC2Local.paid` | `https://192.168.1.197:9999/videos/fc2` |
| `sc` | SC local | `com.visar.SCLocal.paid` | `https://192.168.1.197:9999/videos/sc` |
| `xvideos` | Xvid | `com.visar.Xvid.paid` | `https://www.xvideos.com/account/uploads` |
| `porntrex` | Ptrex | `com.visar.Ptrex.paid` | `https://www.porntrex.com/my/videos/` |
| `tango-live` | Tango | `com.visar.Tango.paid` | `https://tango.me/` |

**Tango** is the former Stream Viewer app (its repository was imported with history into
`apps/tango`, which now keeps only its documentation and notes). It runs the shared viewer's
`tango-live` provider on tango.me and hosts three Safari extensions: **Tango Login**
(`.Login`, the Safari login handoff), **FC2 live** (`.FC2Live`) and **SC live** (`.SCLive`),
the download-list bars from `packages/live-extensions`.

## Behavior: a full-screen Safari tab

- **Local apps** load the PC's page, API, +/- list buttons and HLS exactly as in
  Safari. No website code is bundled; deploying the website updates them. The phone
  already trusts the PC's mkcert root. Navigation is limited to the start URL and
  its subpaths (`VideoApp/Policy.swift`).
- **Online apps** load the provider's own site and run its content script
  (`packages/app/scripts/build-content.mjs <provider>`) at document start in the page
  world: the same Video Platform list/player as the website.
  Their page stays on the site's hosts over HTTPS; other sites (including ads) are
  blocked, and embedded frames (such as a captcha) are allowed. They identify as Safari.
  Login uses the site's own password form inside the app; the app stores no
  passwords. Logins are durable (`VideoApp/SiteCookies.swift`):
  - WebKit writes cookies to disk only when the app is suspended, so a login
    followed by a kill without a background transition (a swipe from the app
    switcher) was lost. The app keeps its own copy of the login cookies
    (`keepCookies`, plus the durable cookie) in its container, beside WebKit's
    cookie file, and restores missing ones before the first page loads. When the
    site removes them (logout, revocation, expiry) the copy is cleared too.
  - XVideos keeps its login in a session-only, version-1 `session_token_auth`
    cookie. The app gives it `session_token`'s lifetime (about three months,
    sliding), stored as a version-0 cookie because
    Foundation ignores Expires on version-1 cookies. XVideos re-sends the
    session-only cookie on responses, so this re-runs every 3 seconds while open
    and at resign/background. With "remember me" ticked XVideos itself sets a
    30-day sliding login cookie.
  - Porntrex keeps **one active session per account; the newest login wins** (verified
    2026-10-02). A password login, or signing back in with the 30-day `kt_member` cookie,
    logs every other device out, which is why `kt_member` "disappeared" during testing.
    Ptrex therefore shares the pipeline's session instead of logging in:
    `npm run ptrex:connect-iphone` (phone unlocked, attached to the Mac) copies the
    pipeline's `PHPSESSID` into Ptrex, pinned for 400 days, and removes `kt_member`.
    Ptrex keeps `PHPSESSID` among its login cookies so a kill does not lose it. Do not
    log in on the phone: it stops the pipeline; run
    the command again instead. Porntrex redirects to its
    ad-heavy home page instead of showing a page: from `/my/videos/` when signed
    out (Ptrex opens `/login/`) and from `/login/` when already signed in (Ptrex
    opens `/my/videos/`).
- **Tango** signs in with Google, which a web view cannot do, so it keeps the original
  handoff: sign in on tango.me in Safari, Import with the Tango Login extension, delete
  Tango's Safari website data and confirm in the app ("Safari data cleared — continue").
  `VideoApp/TangoSession.swift` then moves the imported cookies from the shared Keychain
  inbox into the web view (emptying the inbox) and gives the page the account and session
  IDs from the token; the website refreshes the session and the page renews 5-second
  playback tokens itself, so there is no native auth owner or media relay any more.
  SiteCookies keeps `Tango-RT`/`-DI`/`-DeviceId` durable. When Tango reports the session
  gone, the viewer navigates to `videoapp://login` and the app shows the handoff screen.
  FC2 live and SC live need enabling once in Safari's extension settings, with their sites
  allowed; their background pages call the PC's `/api/fc2|sc/list|add|remove`.
- Like a restored Safari tab, a killed app reopens the page you were on with its
  Back/Forward list (WebKit `interactionState`); only an app page becomes the restore
  point, and a blank restore falls back to the start page. Edge-swipe Back/Forward, pinch zoom,
  inline playback, portrait/landscape and pull-down reload. An unreachable PC or site
  shows a message with Retry instead of Safari's error page.
- Each app has its own WebKit storage: progress, highlights and cookies are not
  shared with Safari. No icon, launch artwork, entitlements or background refresh.

## Build, deploy and inspect

Start with [shared Mac access](/home/visar/Documents/environment/mac-access.md).
Mac mirror: `/Users/visar/Developer/video-platform/apps/ios`. Phone:
`00008101-000639912881401E`; paid team `65U58U86DD`. From this folder:

```sh
python3 scripts/deploy.py <provider> sync      # online apps: builds and stages content.js
python3 scripts/deploy.py <provider> test      # policy tests on the Mac
python3 scripts/deploy.py <provider> build     # attached GUI session, signing lock
python3 scripts/deploy.py <provider> status
python3 scripts/deploy.py <provider> install   # verifies, installs over, launches
```

`install` checks bundle ID, display name, start URL, site scope, bundled content
script, icon absence, signature, paid team, phone provisioning and expiry before
replacing the same app. Never uninstall to update (that would sign the online apps
out). No LaunchAgent is created; pause only this repository's idle renewal scheduler before
changing an approved baseline. Physical checks use ios-tools' inspector on the Mac
(`~/Developer/ios-tools/inspector`, see its README) with `--bundle <bundle ID> --snapshot-file
scripts/inspector-snapshot.js` while the app is in the foreground.

## Renewal

This repository renews its own apps with its Mac scheduler,
`com.visar.renewal.video-platform` ([ios-tools renewal](../../../../ios-tools/renewal/PAID-REFRESH.md)).
`scripts/renewal.py` lists the monthly entries (Mac mirror `/Users/visar/Developer/video-platform/apps/ios`):
`<provider>-local` (local apps) and `<provider>` (online apps). Their inputs are
`VideoApp`, `Shared`, `providers.json`, `scripts/project.py`, `scripts/build-provider.py`
and, for online apps, the staged `build/<provider>/content.js`; Tango also lists `Login`,
`Extension` and its staged web extensions. The Mac needs no Node. A new provider in
`providers.json` needs no change outside this repository; rerun `configure-refresh.py` for this mirror.
After a change: pause the idle scheduler, deploy, approve each changed app, verify
renewal and resume. See `verification.json`.
