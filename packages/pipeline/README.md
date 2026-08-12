# Pipeline foundation

This package owns the future months-long, per-recording processing queue. It is
deliberately separate from the Express server and is not installed as a systemd
service yet.

Implemented foundations:

- SQLite WAL/FULL durable recording state, append-only transition events, leases,
  artifact hashes, description evidence, upload reservations/attempts, and actual
  transmitted-byte accounting.
- Fail-closed discovery inspection: ENDLIST plus a matching version-2
  `.media-integrity.json` with `status: ready` and no invalid segments.
- One-recording stream-copy remux argument/path planning with atomic temporary
  output names.
- Calendar-month upload admission capped at 600,000,000,000 bytes in
  `Europe/Tirane` by default.
- A deterministic upload-plan command and an XVideos adapter that always refuses
  network access.
- A fake-transport coordinator that durably records success, sent bytes on
  failure, and uncertain acceptance without guessing the real HTTP protocol.
- Cleanup hard-disabled.

No command uploads, deletes, moves, remuxes, or describes real video. A read-only
discovery plan is available; applying it writes only candidate metadata to the
new pipeline SQLite ledger. The authenticated XVideos request, processing-status polling, and
playback verification must be learned manually before a real adapter can exist.

Run isolated tests:

```bash
npm test -w pipeline
```

Inspect the new ledger (this creates only the configured SQLite database):

```bash
npm run status -w pipeline
```

Preview finalized recording discovery without writing anything:

```bash
npm run discover:plan -w pipeline
```

After reviewing that output, populate only the pipeline ledger:

```bash
npm run discover -w pipeline
```

Print a dry upload plan without reading credentials, reserving quota, or making
network requests:

```bash
npm run dry-run -w pipeline
```

Failures retain their last successful stage and diagnostic. An explicit ledger
retry restores that exact stage without deleting evidence:

```bash
npm run retry -w pipeline -- RECORDING_ID
```
