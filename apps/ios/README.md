# iPhone apps

One Swift shell (`App/`) and the vendored NativeKit (`Kit/`) build every app; `apps.json`
names them and `scripts/project.py` writes each one's Info.plist and Xcode project.

| App | Key | What it is |
|---|---|---|
| Wimbledon local | `live-a-local` | The PC's recordings of the simulated site A (`ts-live`): the list, the viewer (play, scrub, zoom, the next recording), save (✅), cut, return, markers |
| Wimbledon | `live-a` | Site A itself (`LiveList.swift`, `LiveSite.swift`): the followed accounts that are live now, playing with short-lived stream tokens; follow; "+" puts an account on the PC's download list |

The live app's session is the phone's own token family. The first one comes from the PC
(`LivePCLogin.swift`, the server's `/api/<site>/phone-session`): the PC signs in with its own
account and asks the site for a family for the phone, hands it over once under a durable
request ID, and keeps none of it. From then on the phone renews it itself, one refresh at a
time, saving each rotated refresh token before it uses the new session.

## Settings

`apps.local.json` beside `apps.json` (never in Git) holds a deployment's own values:

```json
{"bundlePrefix": "com.example", "pcServer": "https://192.168.1.10:29999", "pcAwayServer": "",
 "liveSites": {"ts-live": "https://192.168.1.10:28081"}, "phoneKeys": {"ts-live": "<the PC's ts-live-phone-key>"}}
```

Without it the apps expect the demo pod (`deploy/demo`) on the same machine: the PC at
`https://localhost:29999`, site A at `https://localhost:28081`. The phone key is the PC's
`~/.local/share/video-services/ts-live-phone-key`; for the demo, the `ts-live-phone-key` in its
settings folder (deploy/demo/README.md, "On demand"), which every fresh start reuses.

## Signing for a phone

`scripts/renewal.py` declares the apps to a signing service (ios-tools' `ios-push`, which
builds on the Mac, signs, and installs or publishes for an install from anywhere): name, bundle
ID (`bundlePrefix` + the app's `bundleSuffix`), inputs, and `scripts/build-app.py APP`, the
signed device build (`DEVELOPMENT_TEAM`, `SIGNING_DEVICE`). A phone build reaches the PC and
the live site at the addresses `apps.local.json` names, e.g. the demo on the PC's LAN address.

## Building and checking on a Mac

```sh
scripts/build-check.sh live-a-local        # an unsigned simulator build (x86_64)
python3 scripts/check-local.py --device UUID --app build/DerivedData/Build/Products/Debug-iphonesimulator/WimbledonLocal.app \
    --out /tmp/qa-local --cert demo-cert.pem --save
python3 scripts/check-live.py --device UUID --app .../Wimbledon.app --out /tmp/qa-live --cert demo-cert.pem
```

The walk-throughs drive a simulator build through its test hooks (`Kit/Sources/KitTestHooks`,
simulator builds only) and leave a screenshot per step and a `report.json`:

- `check-local.py`: the list matches the server's, the first recording plays, the next one,
  zoom, back to it highlighted, a recording still being captured plays at its live edge;
  `--save` saves the first original with ✅ and waits for the server to list it as kept;
  `--offline` expects the list's failure message with the PC unreachable.
- `check-live.py`: from a fresh install the PC signs the phone in, the followed streams list
  and play, playback outlives the stream tokens (about 10 s), the next stream plays, and a
  relaunch shows the kept list at once and refreshes it without the PC.

`--cert` adds the demo's certificate (it names `localhost`) to the simulator once. A Mac that
is not the PC reaches the demo through forwarded ports, e.g.
`ssh -N -R 29999:127.0.0.1:29999 -R 28081:127.0.0.1:28081 mac` from the PC.

Known on the Intel Mac's iOS 26.3 simulator (lean or full boot): emoji draw as boxed question
marks, so the overlay's emoji buttons (🔇, ✅, ❤️, ➕ ...) show "?" and come out wider than on a
phone, and the third one runs past the screen's edge. The walk-throughs find the buttons by their
text; a phone draws them normally.
