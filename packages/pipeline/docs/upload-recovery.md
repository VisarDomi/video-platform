# Upload recovery policy

Applies to Porntrex. An upload's identity is its exact title
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
- Without a stored ID, look the upload up by its exact identity suffix. Porntrex scans every page of My Videos and
  also accepts the user's manual uploads whose title ends with the unbracketed identity. A Porntrex row
  marked "Error" (Porntrex's own processing failed: no link, Edit disabled) counts toward the list
  total but is no copy of the recording; any other row without a link stops the scan.
- One exact match: persist its provider ID and verify playback: a stream at least 1080 tall on its
  short side (1920×1080, or 1440×1080 for a 4:3 upload; 0.5% tolerance).
- Known ID: keep checking that upload. Processing delays, missing playback tiers and provider errors
  never authorize a new upload.
- A known ID whose edit page answers HTTP 404 (on Porntrex: and absent from My Videos) was removed by
  the provider. The recording is retained and the removal is kept in
  `provider_removals`: that provider never gets it again, including in a joined batch.
  A newly confirmed loss is reported once; after acknowledgement it appears as
  retained history in `scripts/babysit_health.py`, rather than a current pipeline
  failure. Protective blocked states and cleanup exclusions remain unchanged.
- A known Porntrex ID without a published link that My Videos still marks "Error" at the check a day
  after submission is blocked for review the same way rather than re-uploaded, since the same file may
  fail again and the Error row cannot be deleted. ("Error" can clear: one upload was published about
  ten hours later.)
- A complete authenticated search records `absent` from a full list whose row count equals the
  Public/Private tab totals, or, since those totals still count a video Porntrex has removed, a list
  that ends short of them: after a full page the next page answers 404 twice, 2 seconds apart. It is not proof that the provider never received any bytes. No new upload
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

Transfer diagnostics observe the page's same-origin multipart chunk POSTs to
`/upload-video/`, as well as the older `mode=async&action=upload_file` URL.
Listeners attach before file selection/submission, so immediate HTTP errors,
login redirects and non-JSON rejections are retained in the attempt evidence.
Chunk recognition uses request headers without buffering the media body.
The provider's KVS client still owns slicing, assembly and metadata submission,
but the pipeline caps its chunks at 4 MiB. An XHR with no byte progress or
response for 60 seconds is aborted; KVS retries that same index, keeping the
previously accepted prefix. Three attempts at one index are the limit. Byte
progress and successful chunk acknowledgements reset the transfer's ten-minute
idle deadline even while the whole-percent display is unchanged.
The final, media-free assembly request keeps that ten-minute deadline; the
one-minute media-request watchdog must not replay a normal server assembly.

Chunk body/envelope claims are checked against the existing artifact + 16 MiB
reservation before sending. A 2 KiB allowance covers each bounded KVS multipart
envelope. Claims include internal failed/retried requests and the remaining
unique media, so retries cannot spend unreserved bytes. Full-artifact transfer
intent remains conservatively charged on early failure; any additional claims
are committed before transmission, and survive worker failure. Historical
attempt charges are not rewritten. Exhausted retries/allowance return the
recording to the ordinary bounded campaign cooldown before metadata submission.
An empty diagnostic from an older worker does not establish why it stalled.

The `lookup_state`, `lookup_checked_at`, `retry_not_before`, `limited_visibility` and `metadata_rejection`
attempt columns survive worker restarts, independent of the bounded (16-entry) evidence history.
`limited_visibility` is informational only: it never affects verification or retry eligibility.
`metadata_rejection` records phrases the provider refused ("Sorry, 'X' is not allowed here"); the form was
not validated, so no video exists. The phrases are learned in `rejected_phrases` (see `packages/pipeline/setup.md`,
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
