# User systemd configuration

This directory is the source of truth for video-platform user units and their
resource hierarchy. Do not maintain independent copies in chezmoi or edit the
installed files under `~/.config/systemd/user` directly.

| Unit | Runs |
|---|---|
| `video-server.service` | `~/.local/bin/video-server` (API, frontend, finalization) |
| `video-downloader.service` | `~/.local/bin/video-downloader` |
| `video-auth.service` | `~/.local/bin/video-auth` on display `:111` |
| `video-pipeline.service` | `npm run campaign-worker -w pipeline` on display `:111`, with network uploads on and cleanup off |
| `video-ptrex-session.timer` / `.service` | shared-session health, coordinated recovery and pending phone delivery every ten minutes; never starts uploads or changes campaign intent |
| `video-xvfb.service` | Xvfb display `:111` (1920x1080) for the auth and pipeline browsers |
| `video-processing.slice` | the shared resource boundary below |

Repository units are templates. `{{HOME}}` is expanded to the invoking user's
home directory before comparison or installation, so committed files contain
no local username. An unusual installation root can be supplied explicitly:

```bash
npm run systemd:check -- --home /absolute/home
npm run systemd:sync -- --home /absolute/home
```

Check whether the installed files match the repository:

```bash
npm run systemd:check
```

Install the differing repository files and reload the user systemd manager:

```bash
npm run systemd:sync
```

Synchronization manages only the files explicitly listed in
`scripts/sync-systemd.mjs`. It does not enable, disable, start, stop, or restart
services. Restart an affected service explicitly after reviewing a change.

Enable `video-ptrex-session.timer` independently of `video-pipeline.service`. It remains
enabled during gaming pauses so server-side session expiry is not tied to conversion
CPU usage. Healthy checks open no browser and the one-shot service exits between runs.
The service opts into automatic recovery with `VIDEO_PTREX_AUTO_RECOVER=1`, runs at nice
19 with a 50% CPU quota, 768 MiB memory limit and five-minute deadline, and uses display
`:111` only when confirmed authentication loss needs a coordinated browser login.
Healthy live workers suppress duplicate checks; authentication-paused workers and pending
phone handoffs can still recover. Kernel locking excludes concurrent timer/manual recovery,
including after process death. Authentication failures back off from thirty minutes to six
hours; unavailable phones and pending delivery retry after ten minutes. Recovery never
changes campaign intent or starts `video-pipeline.service`. A gaming hold remains in force.

`video-processing.slice` is the aggregate CPU, memory, and swap boundary
(`CPUQuota=600%`, `MemoryHigh=70%`, `MemoryMax=80%`, `MemorySwapMax=0`) for the
server, the pipeline worker, and the transient scopes started by the bounded
commands (`finalize-library -w server`, `describe-one:bounded -w descriptor`,
and the pipeline's `remux-one` and `describe-one`). The downloader, auth, and
Xvfb deliberately remain outside it. The server's drop-in gives live API and
finalization work `CPUWeight=1000`; the pipeline worker runs at `CPUWeight=100`,
like the catalogue finalization and descriptor scopes at the default weight.
The `video-finalize-library-single.scope` drop-in gives exact single-recording
finalization `CPUWeight=1000`.

`video-pipeline.service` runs Node from `~/.nvm/versions/node/v22.19.0`; update
its `PATH` and `ExecStart` when that Node version changes.
