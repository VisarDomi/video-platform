# Video platform

A self-hosted pipeline for live video: it records live streams as they happen, finalizes
and repairs the recordings, lets you watch and edit them from a phone, converts and
describes them, uploads them to a video host, and verifies the uploads until they are
safe to clean up locally. It runs unattended on one PC and is built to survive a power cut
at any moment.

It runs every day in production. A test program with its write rules lost no saved data in
160 random power cuts of a virtual machine; with ordinary writes it lost data in 17 of 30
([deploy/vm/README.md](deploy/vm/README.md)). `npm run demo` runs the whole platform
against the simulator ([Running it](#running-it)).

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
| `packages/pipeline` | Conversion, description, upload and verification: a SQLite ledger with a state machine, a daily upload allowance per network (a second uplink optional), retries that never duplicate an upload, removal bans, receipt-matched cleanup, and a dashboard |
| `packages/descriptor` | Describes a recording with a local vision model (llama.cpp) for its title and description |
| `packages/app` | The website: lists, a viewer with editing, phone-first gestures |
| `packages/live-extensions` | Safari web extensions built from each site plug-in's description |
| `apps/ios` | The iPhone apps (Swift, one shell): a local app per site that plays and edits the PC's recordings ("Wimbledon local"), and a live app for the account-gated site ("Wimbledon": the followed streams, signed in from the PC, stream tokens renewed while playing), with walk-throughs on a simulator ([apps/ios/README.md](apps/ios/README.md)) |
| `packages/simulator` | Simulated live sites, a file host and two upload destinations (a browser-style form host and an API host), with scenarios, faults, a ground-truth log and a checker |
| `plugins/*` | Public plug-ins for the simulated sites: `ts-live` (an account-gated live source, with its sign-in), `ladder-live`, `fmp4-live` (live sources), `file-host` (single files copied to the PC), `form-host`, `api-host` (upload destinations) |
| `profiles/tennis` | The tennis content profile: the descriptor's prompt, the description footer and the tags |
| `e2e/` | End-to-end runs: the real downloader and auth daemon against the simulated live sites (`npm run e2e:capture`), the real pipeline against either simulated destination (`npm run e2e:pipeline`, `-- --destination api-host`), the second uplink's carrier, runner and office lane (`npm run e2e:uplink`), the real file-host queue against the simulated file host, killed mid-transfer (`npm run e2e:file-host`) |
| `deploy/demo` | The whole platform against the simulator in one rootless Podman pod, on demand (`npm run demo`; stopping it, or a power cut, leaves nothing behind) |
| `deploy/vm` | A QEMU harness that hard-resets a VM at random points and checks every invariant after each boot |
| `systemd/` | The user services |

A deployment's own plug-ins, configuration and operations live in a separate private
repository, checked out at `private/`. The core finds them through the sites file, so it
never imports one (a test enforces it).

How it fits together, one recording from live stream to verified upload:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Things that broke and the tests that hold the
fixes: [docs/STORIES.md](docs/STORIES.md).

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
- **Bytes are reserved before they leave**, so the upload allowance holds even when a
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
npm run e2e:pipeline -- --destination api-host
npm run e2e:uplink      # about a minute
npm run e2e:file-host   # about a minute
```

Or the whole platform at once, against the simulator, in a Podman pod (Podman only):

```sh
npm run demo            # then https://localhost:29999 (see deploy/demo/README.md)
```

## Licence

MIT, see [LICENSE](./LICENSE).
