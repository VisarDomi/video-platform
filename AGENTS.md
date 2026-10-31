The coding agent owns this repository and the recordings it manages: any file may be changed, this one included. The user's only manual task is deleting old recordings to free disk space, so a recording that disappears is expected, not an error.

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
