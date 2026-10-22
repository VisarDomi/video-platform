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
| `video-ptrex-session.timer` / `.service` | one cookie-only authentication check every ten minutes while the upload worker is stopped; never starts uploads or changes campaign intent |
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
CPU usage. The one-shot service runs at nice 19 with a 10% CPU quota and 128 MiB memory
limit, opens no browser, and exits between checks. A fresh worker heartbeat suppresses
duplicate checks. Password recovery is never scheduled; the agent handles it through the
coordinated PC/phone recovery command when needed, preserving the gaming hold.

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
