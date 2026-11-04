# Upload recovery policy

Applies to Porntrex. An upload's identity is its exact title
suffix: `[<recording folder>]`, `[<recording folder> | part N]` for one shape of a split recording,
or the comparison-queue diagnostic `[<recording folder> | production-v6 | <part>]`.

## Durable state

SQLite is the workflow authority: WAL, synchronous FULL, guarded transitions and state-event history.
An upload attempt is committed before network transfer, with a `retry_not_before` deadline seven days
after its start stored at creation. While the file is in flight the persisted phase stays `started`;
`transfer_started` records that the transfer began.

`upload_artifact_receipts` snapshots each attempt's exact generated path, size,
SHA-256, source fingerprint and submitted metadata before transfer. Complete file
acceptance plus a captured remote ID after metadata submission commits `accepted_at`
and `verify_after` (the seven-day retry gate), plus a first check 24 hours later; `upload_uncertain` still means playback has
not yet verified. `VIDEO_PIPELINE_CLEANUP=1` immediately unlinks only the matching
MP4, flushes its directory, then checkpoints `deleted_at`. Missing/already-deleted
files are idempotent; mismatched bytes, symlinks, active work, comparison evidence,
known removals and legacy uncertain rendition holds do not authorize deletion.

Acceptance commits before unlink. A crash after capturing the remote ID restores
the same original retry deadline and daily check schedule, bills transferred bytes, and resumes cleanup. A crash
after unlink retries only the deletion checkpoint. An uncertain submission without
an ID retains its conversion until exact recovery establishes acceptance. Unused
reservations are released; failures before metadata submission remain normal
retryable transfers. Every transmitted byte stays charged.

## Reconciliation

- Check accepted uploads every 24 hours, starting one day after acceptance, and
  verify a ready Full-HD copy immediately on that check. An unknown submission
  also gets daily identity checks. The independent seven-day deadline controls
  only when another conversion/upload may be attempted; it never delays a check.
  Recovered acceptance preserves both clocks. Schema16 atomically repairs existing
  weekly confirmation dates and leaves later daily backoff intact on reopen.
- Require a published slug URL and actual Full-HD playback dimensions (1920×1080,
  or 1440×1080 for 4:3, with the existing tolerance). Probe player-source URLs
  first, with download endpoints as fallback: a download URL can fail while its
  player stream works. Labels alone are insufficient.
- A never-verified accepted submission definitively absent, marked processing
  failure, or still processing without a public copy after its week is queued for
  conversion/upload from the unchanged original. Retry only the affected part or
  joined batch; retain other queued parts and all old IDs/receipts. A successful
  retry deletes its new conversion and starts a fresh seven-day retry window with daily checks.
- Missing/changed originals defer rebuilding and keep remote checks pending.
  Other recordings continue. `local_source_presence` tracks local absence without
  deleting recording, receipt, state-event, removal or bandwidth history.
- A known removal ban or a previously verified copy later removed never authorizes
  restoration, including inside joined batches. Existing acknowledged losses stay
  retained history, not current queue failures. Legacy published rendition holds
  retain their conversions; published but uncertain quality keeps checking.
- A 404 edit page is not absence: scan **all** of My Videos, including processing
  and failed rows beyond page one. A complete list must match the Public/Private
  totals, or end after a full page with two subsequent 404s two seconds apart.
  A listed published copy with an unavailable edit page is inconclusive.
- Auth/network failures, incomplete rows/pagination, ambiguous identity matches and
  failed CDN probes remain pending; they never authorize deletion or another upload.
  Exact identity lookup immediately before transfer remains duplicate protection.
- Attempts with neither transfer-start nor byte evidence, and definitive pre-submit
  failures, do not hold a weekly retry deadline. Login/provider cooldowns still apply.

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
daily checks and seven-day retry timing across reopen, visibility and rejection flags that outlive the evidence history,
reference fallback, atomic verification rollback, accepted-but-unverified recovery, unused reservations,
artifact flushing, and SIGKILL after transfer/ID persistence.
`test/workerRecovery.test.mjs` exercises actual worker/encoder interruption and restart.

`test/acceptedRetention.test.mjs` covers acceptance/deletion/reopen, seven-day retry
and fresh deadlines, missing/changed originals, migration, legacy holds, known
removal bans, SIGKILL at acceptance, split-part coverage and real selected-shape
conversion. Upload-provider fixtures cover complete list checks across pagination
and inconclusive errors. Original files are never cleanup targets.

Browser launch failures retry once after one second, then use the ordinary
15-minute pre-submission cooldown (doubling on repeated failures). Their original
launch diagnostic is preserved. A profile lock or browser startup failure is not
evidence of logout and must not request a password login or impose its 24-hour
login hold. Another browser owner's process/profile lock is never removed.

SQLite startup applies its bounded30-second busy timeout before any schema work,
so concurrently starting worker/auth-maintenance processes can wait for an active
writer. Already committed retention tables are inspected without acquiring another
write transaction on every open. Missing tables still recover through normal
initialization. `test/databaseStartup.test.mjs` covers real cross-process contention
beyond five seconds and interrupted retention initialization in temporary databases.
