# Upload recovery policy

Production remains `production-v6`. Titles remain `model title [recording directory basename]`.
This upgrade does not reset upload history, descriptions, conversion policy, or bandwidth accounting.

## Durable state

SQLite is the workflow authority: WAL, synchronous FULL, guarded transitions and state-event history.
An upload attempt is committed before network transfer. Its seven-day `retry_not_before` is stored at
creation, rather than calculated from worker uptime. `transfer_started` disambiguates legacy schemas
whose persisted phase stays `started` while the file is in flight.

Provider IDs are saved as soon as captured. Acceptance, confirmation completion, remote identity and
verified recording state commit in one transaction. Old accepted-but-unverified interruptions are
returned to verification, not to uploading. Unused reservations are released on restart.

## Reconciliation

- First check after 24 hours; unresolved verification/search checks recur daily.
- Search by the exact bracketed filename (or exact version/part identity for diagnostic titles).
- One exact match: persist its provider ID and verify playback using the existing Full-HD pixel policy.
- Known ID: keep checking that upload. Processing delays, missing playback tiers and provider errors
  never authorize a new upload.
- A complete authenticated search with the provider's explicit empty-result marker records `absent`.
  It is not proof that the provider never received any bytes. No new upload is eligible until the
  previous attempt's seven-day deadline, and the retry performs another lookup immediately before transfer.
- Authentication errors, unexpected pages, incomplete rows, pagination and ambiguous matches do not
  establish absence. They remain pending for another lookup.
- Pre-transfer failures (no bytes/transfer-start evidence) do not consume a weekly reupload slot;
  existing login/provider cooldowns still apply.

The `lookup_state`, `lookup_checked_at`, `retry_not_before` and `limited_visibility` attempt columns
survive worker restarts. Limited-visibility warnings are sticky diagnostics, independent of the bounded
submission-text history. They do not invalidate saved metadata, cause resubmission, or authorize reupload.
An existing limited-visibility upload can still pass playback verification normally.

## Source references and artifacts

Unresolvable supported-provider identifiers remain honestly unresolved in the provenance table, but
upload metadata uses `Source: TODO LATER`. No fake account ID or alias is generated. Resolved references
remain unchanged; unsupported/missing provenance is not silently accepted.

Completed remuxes, conversions and cached artifacts are flushed before the final directory entry is
committed to the workflow. Interrupted partial outputs are not treated as completed artifacts.
This relies on the filesystem/storage honouring flushes; SQLite cannot make a remote provider and the
local database commit atomically. Reconciliation handles that external boundary.

## Verification coverage

`test/recoveryPolicy.test.mjs` covers exact identity recovery, negative/ambiguous/error lookup handling,
seven-day timing across reopen, sticky visibility flags, reference fallback, atomic verification rollback,
legacy recovery, unused reservations, artifact flushing, and SIGKILL after transfer/ID persistence.
`test/workerRecovery.test.mjs` also exercises actual worker/encoder interruption and restart.
