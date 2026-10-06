# Upload recovery policy

Applies to both upload providers (Porntrex and XVideos). An upload's identity is its exact title
suffix: `[<recording folder>]`, `[<recording folder> | part N]` for one shape of a split recording,
or the comparison-queue diagnostic `[<recording folder> | production-v6 | <part>]`.

## Durable state

SQLite is the workflow authority: WAL, synchronous FULL, guarded transitions and state-event history.
An upload attempt is committed before network transfer, with a `retry_not_before` deadline seven days
after its start stored at creation. While the file is in flight the persisted phase stays `started`;
`transfer_started` records that the transfer began.

A provider ID is saved on the attempt as soon as it is captured. Acceptance, confirmation completion,
remote identity and verified recording state commit in one transaction. After an interruption,
recovery returns accepted-but-unverified attempts to verification, not to uploading, releases
reservations that never started an attempt, and marks an attempt interrupted after its transfer began
as uncertain, to be checked 24 hours later.

## Reconciliation

- The first check is due 24 hours after submission; unresolved verification and lookup checks recur
  daily. A Porntrex video that is still processing is checked again after two hours.
- Without a stored ID, look the upload up by its exact identity suffix. XVideos searches the uploads
  list for the folder name and requires the exact suffix; Porntrex scans every page of My Videos and
  also accepts the user's manual uploads whose title ends with the unbracketed identity.
- One exact match: persist its provider ID and verify playback: a stream of at least the Full-HD pixel
  count (1920×1080, 0.5% tolerance).
- Known ID: keep checking that upload. Processing delays, missing playback tiers and provider errors
  never authorize a new upload.
- A known ID whose edit page answers HTTP 404 (on Porntrex: and absent from My Videos) was removed by
  the provider. The recording is blocked for review; `npm run retry -w pipeline -- RECORDING_ID`
  re-uploads it without the seven-day wait.
- A complete authenticated search records `absent`: on XVideos an unpaginated result page with the
  explicit "Your filters return no video." marker, on Porntrex a full list whose row count equals the
  Public/Private tab totals. It is not proof that the provider never received any bytes. No new upload
  is eligible until the attempt's seven-day deadline; the retry looks up again immediately before
  transfer.
- Authentication errors, unexpected pages, incomplete rows, unexpected pagination and ambiguous matches
  do not establish absence. They remain pending for another lookup.
- Attempts without transfer-start or byte evidence do not hold the seven-day deadline. Neither do
  definitive failures in which no video can exist: a metadata refusal, a transfer that stopped before
  the metadata form, or any Porntrex failure before its metadata form was submitted (Porntrex creates
  the video only on that submit; such uncertain attempts are settled as failures on the next campaign
  step or reconcile).
  Login and provider cooldowns still apply.
- `xvideos:sync` settles open XVideos confirmations from the complete account inventory: an ID missing
  from it is dropped and the attempt is settled by that inventory like an attempt without an ID.

The `lookup_state`, `lookup_checked_at`, `retry_not_before`, `limited_visibility` and `metadata_rejection`
attempt columns survive worker restarts, independent of the bounded (16-entry) evidence history.
`limited_visibility` is informational only: it never affects verification or retry eligibility.
`metadata_rejection` records phrases the provider refused ("Sorry, 'X' is not allowed here"); the form was
not validated, so no video exists. The phrases are learned in `rejected_phrases` (see `setup.md`,
"Rejected metadata phrases").

## Source references and artifacts

Identifiers the API server cannot resolve remain honestly unresolved in the provenance table, but upload
metadata uses `Source: TODO LATER`. No fake account ID or alias is generated. Resolved references remain
unchanged; other unresolved or missing provenance blocks upload until it is reviewed.

Completed conversions, remuxes and cached artifacts are flushed before the final directory entry is
committed to the workflow. Interrupted partial outputs are not treated as completed artifacts.
This relies on the filesystem/storage honouring flushes; SQLite cannot make a remote provider and the
local database commit atomically. Reconciliation handles that external boundary.

## Verification coverage

`test/recoveryPolicy.test.mjs` covers exact identity recovery, negative/ambiguous/error lookup handling,
seven-day timing across reopen, visibility and rejection flags that outlive the evidence history,
reference fallback, atomic verification rollback, accepted-but-unverified recovery, unused reservations,
artifact flushing, and SIGKILL after transfer/ID persistence.
`test/workerRecovery.test.mjs` exercises actual worker/encoder interruption and restart.
