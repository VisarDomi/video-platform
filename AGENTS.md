The coding agent owns this repository and the recordings it manages: any file may be changed, this one included. The user's only manual task is deleting old recordings to free disk space, so a recording that disappears is expected, not an error.

The phone apps are for exploring; the PC pipeline is the backup engine. Keep the
phone's ordinary provider session renewal independent of the PC. Initial setup or
an API migration may use the PC/Safari helper once; normal expiry, backgrounding
and network changes must renew the existing session automatically. PC recording
and phone sessions have separate refresh-token families and one owner each.
Every ordinary PC browser/authentication flow runs headful on Xvfb `:111`; never
inherit the desktop display. Routine iPhone UI checks use the Mac virtual iPhone;
reserve the physical device for behavior that cannot be established there.

Handle routine project repairs autonomously without requesting confirmation. This includes
Porntrex session recovery: reuse a valid shared session first; if every retained copy is
rejected, perform one coordinated PC login through `ptrex-connect-iphone --apply
--allow-password-login`, share it immediately with Video Vault and verify both devices.
This coordinated recovery is authorized; do not ask again. Never log in independently on
the phone or present `kt_member`. Keep the user's upload/gaming hold intact throughout.
Session maintenance continues while the resource-heavy upload worker is stopped. The
managed job repairs confirmed authentication loss automatically, preferring any valid
phone copy before a password login and retaining failed phone delivery for retry. Never
turn a provider outage into a new login, repeat password logins for delivery failures,
or resume a gaming hold as a side effect of authentication repair.

## Start here

- [README.md](README.md): what the system does, and a map of every doc.
- [notes.md](notes.md): setup: packages, services, logs, data outside the repository, download lists.
- [decisions.md](decisions.md): the system's rules and why they hold.
- [apps/ios/README.md](apps/ios/README.md): the six iPhone apps: behaviour, rules, build, deploy, tests, frame reports, renewal.
- Each package's own docs sit next to its code (`packages/<name>/`, `systemd/`): an overview (`README.md` or `setup.md`) and its rules (`decisions.md`); README.md's Docs section lists them all.
- [NativeKit guide](../../ios-tools/native/README.md): the shared iPhone modules, vendoring into `apps/ios/Kit`, main-thread rules, relaunch restore, FrameMonitor, simulator limits.
- [Mac and phone access](../../../environment/mac-access.md): SSH to the Mac, UDIDs, signing.
- [Renewal](../../ios-tools/renewal/README.md): the monthly re-signing of the paid apps.

The viewer follows the user directly: free continuous scrolling, content loading in place,
and pinch zoom of the same content. Never add snapping, automatic centering, page landing,
runways or repositioning when scrolling stops. Loading, refreshes and player reuse preserve
the visible position. Cached next chapters must append during continuous scrolling; do not
require a scroll-end or settled-page check. Explicit navigation and restoration are separate.

Video visibility is independent of scrolling coordinates: at rest or while zoomed only
the current video is shown. Neighbours appear only during an unzoomed vertical scroll.
Every VOD provider pauses neighbours; only Tango live keeps neighbours playing muted.
Zoom disables carousel navigation. Never turn a visibility transition into snapping.
