# The demo pod

The whole platform against its simulator, in one rootless Podman pod: three simulated live
sites (tennis), a file host and an upload destination, and the real services working them:
the auth daemon keeps the account-gated site signed in, the downloader records whoever is
live, the server finalizes the recordings and serves the website, the file-host queue copies
single files, and the pipeline converts, describes, uploads and verifies.

```sh
npm run demo          # builds localhost/video-platform-demo and plays the pod
npm run demo:down     # stops it (the volume stays)
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
- `DEMO_CLEANUP=1`: let the pipeline delete recordings once their upload is verified.
- A folder of videos mounted at `/media` (commented out in the YAML).
- The container is limited to two CPUs and 4 GiB.

## Always on

`video-platform-demo.kube` is a Quadlet unit for the same pod:

```sh
cp deploy/demo/video-platform-demo.{kube,yaml} ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start video-platform-demo
```

With lingering enabled (`loginctl enable-linger`) it comes back after a reboot or a power
cut: systemd restarts the pod, and the supervisor resumes from the volume (the ledger, the
recordings, the simulator's state). Recordings accumulate on the volume unless
`DEMO_CLEANUP=1`.
