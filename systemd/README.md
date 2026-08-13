# User systemd configuration

This directory is the source of truth for video-platform user units and their
resource hierarchy. Do not maintain independent copies in chezmoi or edit the
installed files under `~/.config/systemd/user` directly.

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

Install the exact repository versions and reload the user systemd manager:

```bash
npm run systemd:sync
```

Synchronization manages only the files explicitly listed in
`scripts/sync-systemd.mjs`. It does not enable, disable, start, stop, or restart
services. Restart an affected service explicitly after reviewing a change.

`video-processing.slice` is the aggregate CPU, memory, and swap boundary for
the server and pipeline processing scopes. Downloader and auth deliberately
remain outside it. The server's drop-in gives live API/finalization work higher
CPU weight than background catalog, remux, and descriptor work.
