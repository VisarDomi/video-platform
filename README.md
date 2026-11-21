# Video platform

A self-hosted pipeline for live video: it records live streams as they happen, finalizes
and repairs the recordings, lets you watch and edit them from a phone, converts and
describes them, uploads them to a video host, and verifies the uploads until they are
safe to clean up locally. It runs unattended on one PC and is built to survive a power cut
at any moment.

The core knows no site. Live sources, file hosts, upload destinations and the way
recordings are described are **plug-ins** behind a small SDK. This repository ships the
core, the SDK, a **simulator** of every kind of site, and public plug-ins written against
the simulator, so the whole system runs end to end without touching a real service. The
simulated live sites are three tennis tournaments, each a different kind of live site:
Wimbledon (`ts-live`: account-gated HLS over MPEG-TS), Roland-Garros (`ladder-live`: an HLS
address from a control-channel handshake) and the Australian Open (`fmp4-live`: fMP4 from
several CDN edges). Recordings are described with a tennis content profile.

## What is in here

| Path | What it is |
|---|---|
| `packages/sdk` | The plug-in contracts (site, live capture, catalog, sign-in, file host, destination, content profile), the plug-in registry and a crash-safe plug-in store |
| `packages/downloader` | Live capture: HLS playlists polled per channel, segments written durably, edge failover, honest gap accounting |
| `packages/server` | The API, finalization (repairing and closing recordings), download lists, the website's backend |
| `packages/auth` | Keeps every site's sign-in fresh, in one place |
| `packages/pipeline` | Conversion, description, upload and verification: a SQLite ledger with a state machine, a monthly upload budget, retries that never duplicate an upload, removal bans, receipt-matched cleanup, and a dashboard |
| `packages/descriptor` | Describes a recording with a local vision model (llama.cpp) for its title and description |
| `packages/app` | The website: lists, a viewer with editing, phone-first gestures |
| `packages/live-extensions` | Safari web extensions built from each site plug-in's description |
| `packages/simulator` | Simulated live sites, a file host and two upload destinations (a browser-style form host and an API host), with scenarios, faults, a ground-truth log and a checker |
| `plugins/*` | Public plug-ins for the simulated sites: `ts-live` (an account-gated live source, with its sign-in), `ladder-live`, `fmp4-live` (live sources), `form-host` (upload destination) |
| `profiles/tennis` | The tennis content profile: the descriptor's prompt, the description footer and the tags |
| `e2e/` | End-to-end runs: the real downloader against the simulated sites (`npm run e2e:capture`), the real pipeline against the simulated destination (`npm run e2e:pipeline`) |
| `deploy/vm` | A QEMU harness that hard-resets a VM at random points and checks every invariant after each boot |
| `systemd/` | The user services |

A deployment's own plug-ins, configuration and operations live in a separate private
repository, checked out at `private/`. The core finds them through the sites file, so it
never imports one (a test enforces it).

## Ideas worth a look

- **No lost or duplicated work across a power cut.** Every durable write is temp file +
  fsync + rename + directory fsync; every ledger change is one SQLite transaction, a new
  ledger included (tested by killing the process in the middle of creating one); the VM
  harness cuts power for real.
- **The creation boundary.** A destination says when a remote copy comes into existence
  (at the metadata form, or when the transfer starts). Before it, a failure is a plain
  failure; after it, the attempt is confirmed against the destination's list, never
  retried blind.
- **"Absent" needs proof.** A destination may say a video is absent only after a complete
  listing; a cached page or a page that should exist but fails is inconclusive.
- **Removed means never again.** A copy the destination removed is recorded and that
  recording is never uploaded there again.
- **Bytes are reserved before they leave**, so the monthly upload budget holds even when a
  transfer dies halfway.

## Running it

Node 22, ffmpeg, and the system Chromium (`/usr/bin/chromium`; browsers that Playwright
downloads are never used).

```sh
npm ci
npm run build:backend
npm test -w sdk && npm test -w pipeline
npm run build -w simulator && npm run build:sim-plugins
npm run test:sim-plugins
npm run e2e:capture     # about two minutes
npm run e2e:pipeline    # about twenty seconds
```

## Licence

MIT, see [LICENSE](./LICENSE).
