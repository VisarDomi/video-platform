# The demo pod

The whole platform against its simulator, in one rootless Podman pod: three simulated live
sites (tennis), a file host and an upload destination, and the real services working them:
the auth daemon keeps the account-gated site signed in, the downloader records whoever is
live, the server finalizes the recordings and serves the website, the file-host queue copies
single files, and the pipeline converts, describes, uploads and verifies.

```sh
npm run demo          # deploy/demo/demo.sh start: a fresh demo (the image rebuilt when the sources changed)
npm run demo:down     # deploy/demo/demo.sh stop: stopped, and everything it made deleted
deploy/demo/demo.sh status
podman logs -f video-platform-demo-platform
```

| On the host | What |
|---|---|
| `https://localhost:29999` | the website: recordings, the viewer, the download lists |
| `https://localhost:28791` | the pipeline dashboard |
| `https://localhost:29998/api/file-host/health` | the file-host queue |
| `https://localhost:28081` … `28087` | the simulated sites (live sites A–C, file host, form host, API host) |
| `https://localhost:28080` | the simulator's control API (`/state`, clock, site actions) |

Inside the pod every service keeps its usual port; the host sees them 20000 higher, so the
demo never meets a deployment on the same machine. Nothing is shared with the host but the
published ports and the `video-platform-demo` volume.

## What runs

`supervisor.mjs` is the pod's entrypoint. On the first start it prepares the simulator's
media (your videos when a folder is mounted at `/media`, otherwise three generated test
patterns), makes a certificate, and writes the sites file, the account files and the download
lists from `packages/simulator/scenarios/demo.json`. Then it starts the simulator and each
service, and restarts a service that exits. The description model is a stand-in that answers
in the descriptor's format; `DEMO_MODEL_URL` points the pipeline at a real one.

The pipeline uploads only the recordings someone kept in the viewer: published into a site's
`edited/` folder with a ready checkpoint, as a cut does. So that the demo runs on its own, the
supervisor keeps all of each finished recording five minutes after it appears, through the
server's API as a cut that keeps every segment does (`DEMO_AUTO_SAVE_MINUTES`;
`DEMO_AUTO_SAVE=0` leaves the choice to you, on the website or the phone).

Settings, in `video-platform-demo.yaml`:

- `DEMO_DESTINATION`: `form-host` (default) or `api-host`.
- `DEMO_CERT_HOSTS`: more names or addresses for the certificate, e.g. the PC's LAN address
  so a phone can open the website. Or mount a certificate the phone already trusts at
  `/demo/home/.local/share/mkcert/pwa` (`cert.pem`, `key.pem`).
- `DEMO_CLEANUP=1`: let the pipeline delete a conversion once the destination accepted its
  upload and the file still matches its receipt. It never deletes an original.
- A folder of videos mounted at `/media` (commented out in the YAML).
- The container is limited to two CPUs and 4 GiB.

## On demand

The demo runs when you need it, to show or record the platform, and not otherwise: it records
its simulated sites all the time (about 2.7 GB an hour) and converts on two CPUs, far slower
than it records, so a demo left on would fill the disk. `deploy/demo/demo.sh`:

- `start [--hours N]` stops any demo first and starts a fresh one: a new volume, the image
  rebuilt only when the sources changed (labelled with their hash). It stops itself after N
  hours (default 8; `--hours 0` never), a transient systemd timer.
- `stop` stops the pod (SIGTERM: the supervisor ends the worker first and the simulator last,
  within 60 s) and deletes its volume and the timer. Nothing of the demo is left.
- `install` adds `video-platform-demo-cleanup.service`, which runs `stop` at every boot: a
  demo cut off by a power loss or a reboot never comes back by itself (the pod's restart policy
  is OnFailure, which Podman does not restart at boot) and its data is removed. It also links
  `video-demo` into `~/.local/bin`.

A deployment's own settings live in a folder the script mounts read-only at `/demo-config`
(`~/.config/video-platform-demo`, or `$DEMO_CONFIG_DIR`): `cert.pem` and `key.pem`, a certificate
its phones already trust, naming `127.0.0.1` and `localhost` (the services inside the pod use
them) and the address phones open, with its issuing CA appended to `cert.pem`; and
`<site>-phone-key` files, the keys its live apps were built with (`apps/ios`). The demo copies
them into place at start, so the apps keep working across fresh starts.
