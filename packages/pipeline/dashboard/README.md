# Pipeline on your phone

Open **https://192.168.1.197:8791/** in Safari, then **Share → Add to Home Screen**.
The saved app works on home Wi-Fi and through the existing Tailscale route to
this PC, with the same URL and home-network certificate already used by Monitor
and the video apps. No account, native build or provider login is required.

The overview shows the active job, recording/finalization/conversion/description/
upload/verification stages, the cumulative Tirana upload allowance, fourteen-day
submission/verification chart, compatible short batches, live disk space and
service CPU/RAM. Queue and Activity tabs provide the detailed job list and real
state transitions. Queue entries are the registered jobs; newly finalized
recordings appear as the worker admits them. The dashboard never performs a
parallel discovery/conversion/upload or provider crawl.

The active-job card shows the generated upload title and complete recording
source-folder path, wrapping without truncation on phones. Before upload metadata
is composed, it uses the descriptor's title when available; earlier stages say
the title has not been generated yet. The source path can be selected and copied.

This is a **read-only** view. Known provider removals are retained history, not
current pipeline errors. Short waiting, normal verification, resource and quota
waits are labeled normally. Manual pipeline controls remain independent; the
dashboard keeps working while the heavy worker is stopped and shows capture
separately. It never starts/resumes anything.

Upload percentage uses media bytes acknowledged by Porntrex, reported at most
every thirty seconds through the attempt's existing bounded evidence. Transfer
completion is separate from metadata submission and online verification. The
ledger's conservative full-file byte claim is **not** transfer progress. An
older worker without telemetry shows an indeterminate transfer rather than
100%. ETA uses recent acknowledgements and is absent when no rate is known.
Conversion shows elapsed time and partial-output size when available; stages
without a measured percentage never invent one.

Disk free/used totals are live. Folder-size breakdowns retain their measured
babysitting inventory timestamp; no recursive disk scan runs on page refresh.
Service RAM is anonymous memory, excluding file cache. CPU is a service's share
of the machine between recent readings; the first reading remains unknown.

## Service and data

`video-pipeline-dashboard.service` runs the standard-library Python server in
this directory on HTTPS8791. The existing TLS key is read only by the server and
is never exposed. Only explicit asset paths and `GET/HEAD /api/dashboard` exist;
write methods are rejected. Clients are limited to loopback, private IPv4 and
Tailscale. The active recording's source path is included for identification;
responses omit signed media URLs, unrelated local paths, cookies and provider
credentials. No media is decoded, transcoded or played for dashboard operation.

All phone tabs share one five-second backend snapshot. The page requests it
every five seconds while visible; hidden pages stop requests and abort pending
ones. Foregrounding and reconnection refresh immediately. A service worker
caches only the shell; API responses are network-only. One last-good snapshot
on the phone supports offline reload, explicitly labeled **Saved / Last seen**.
An unavailable data source returns the previous snapshot as stale, never fresh
zero counts. There is no sampler, scheduled task, persistent metrics database or
new provider/authentication session.

Install with the repository's normal unit sync, then enable only this service:

```sh
node scripts/sync-systemd.mjs --apply
systemctl --user enable --now video-pipeline-dashboard.service
```

Static asset edits are served directly. Restart this dashboard service after
backend changes. Worker telemetry changes follow the normal safe pipeline
deployment procedure; do not rebuild its dist during an active upload.

## Tests

```sh
python3 -m unittest discover -s packages/pipeline/dashboard -p test_dashboard.py
python3 -m unittest discover -s scripts -p 'test_babysit*.py'
node --test packages/app/test/pipeline-dashboard.test.mjs
```

Browser tests use isolated loopback HTTP fixtures, not production metrics.
Chromium and WebKit cover320–1024px widths, search, stage navigation, untrusted
text, offline reload, reconnect, hidden-page polling and manual pause. Temporary
SQLite tests cover byte claims versus true progress, Tirana allowance boundaries,
same-source staleness, read-only access, private data, bounded shared snapshots
and the HTTP allowlist. No actual game, phone UI or provider upload is started
by these tests.
