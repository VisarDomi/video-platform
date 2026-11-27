# Engineering stories

Short accounts of things that went wrong, or nearly did: the symptom, the cause, the fix,
and what keeps it fixed. They are the reasons behind several rules in
[ARCHITECTURE.md](ARCHITECTURE.md).

## A fresh installation finalized recordings an hour late

**Symptom.** The first start of the demo pod logged `pending-root watch failed; hourly
reconciliation remains active` for every site.

**Cause.** The server's finalizer created its `.pending` folders without waiting, then
started watching them. On a machine that had never recorded anything, the watch won the
race and failed with ENOENT, so finalization fell back to the hourly sweep: a fresh
installation would have published its first recordings up to an hour late. Production never
saw it because its folders had existed for months. A comment above the code said the
folders were created "so the watches always have a live target"; the code did not wait.

**Fix.** The folders now exist before the watches start; the disk-space check, which had the
same blind spot, measures the nearest existing folder. The demo pod starts on an empty
volume, so every rebuild of it exercises a first installation.

## An uploads list one video short

**Symptom.** Uploads stopped for 45 minutes. Before each upload, the pipeline reads the
destination's whole list of uploads and compares it with the account's own count; it read
one video fewer than the count, every time, so it could not prove the recording absent and
refused to upload. A fresh browser listed every video.

**Cause.** Not proven. The likeliest one: the pages are sorted by date, so when two videos
share a date, the page boundary can shift between requests and one row appears on two pages
while another appears on none. The rule held exactly as designed (absence was unproven, so
nothing was uploaded twice); it just held too long. The fix does not depend on the cause.

**Fix.** A short list is read again from the first page after a pause, and the rows of both
reads count together. If they still fall short, the list counts as complete only when the
missing rows are exactly the pipeline's own uploads of the last three hours, none of them a
copy of the recording being uploaded; otherwise the upload is stopped, with the rows per page
in the error. After a deployment, a cooldown caused by the fixed fault is cleared
instead of waited out.

## A transfer that resumed from nothing

**Symptom.** In the file-host end-to-end run, a transfer the simulated host cut after 64 KiB
was retried from byte 0 instead of resuming with a range request.

**Cause.** The host reset the connection, and a TCP reset lets the receiving kernel drop
bytes the client had not read yet: the client had written nothing. The queue did the right
thing: it trusts only its fsynced offset, never the length of a partial file, and that offset
was zero.

**Fix.** None in the queue. The test now uses a stall (the host sends 1 MiB, holds the
connection, then drops it), which leaves the client bytes to resume from, and a second case
kills the service with SIGKILL in the middle of a transfer: it resumes from its fsynced
bytes, and the file comes out byte-identical to what the host served.

## Every stream token revoked at once

**What is tested.** The simulated live site A revokes every stream token it has issued, 40
seconds into the capture run. Its playlists answer 401 until the auth daemon's next renewal
(every five seconds) reaches the credential store; the downloader reads the store on every
request.

**What happens.** Both channels' playlists answered 401 four times, logged once when the run
started and once when it ended, and recorded on: no segment was lost, because the live
window (six one-second segments) outlasts the renewal interval. The run also counts the
renewals from the site's own record of what it issued, not from the daemon's logs, which
fold repeated lines.

## A link to 0.0.0.0

**Symptom.** In the demo pod, the file-host queue refused every download from the
simulated file host.

**Cause.** The simulator listened on every address (0.0.0.0), as a pod needs, and built its
signed download links from its listening address: `https://0.0.0.0:18087/...`. The file-host
plug-in allows only the hosts it is configured with, and refused, exactly as its network
guard should.

**Fix.** The simulator advertises the loopback address when it listens everywhere. The
guard was not loosened.

## A public clone that did not install

**Symptom.** Following the README in a fresh clone, `npm ci` failed, and two test suites
failed after that.

**Cause.** The repository was split into a public core and a private deployment repository.
The lockfile had been edited by hand during the split and missed two packages, and two tests
assumed the private folder existed (the plug-in boundary test required private content
profiles; the browser test counted launches that mostly live in private plug-ins).

**Fix.** The lockfile is npm's own, generated in a clone without the private folder, and the
two tests check what a public clone has. The README's quick start now runs end to end in a
fresh clone of the public repository: install, build, the unit tests, and every
end-to-end run.

## Power cuts, measured

**The question.** Is temp file + fsync + rename + directory fsync worth its cost?

**The answer.** The VM harness hard-resets a QEMU guest at random points while a workload
writes, then checks every invariant after each boot. The same journal written both ways:
with the rules it lost nothing in 160 cuts (130 with QEMU's `writeback` cache, 30 with
`unsafe`); without the fsyncs, under `writeback`, it lost acknowledged records in 17 of 30
cuts and left torn state in 4. The numbers and raw results are in
`deploy/vm/README.md`.

## A ledger whose schema was not its own

**Symptom.** The first upgrade of the pipeline ledger in months (schema 17 to 18, for the
second uplink) passed its test, which upgrades a new schema-17 ledger and compares it with a
new schema-18 one, then failed its check on a copy of the live ledger: the upgraded live
schema differed from a new ledger's in column order, quoting and CHECK constraints.

**Cause.** The live ledger had been built over a year by upgrades whose code was removed
once they had run (`ALTER TABLE ... ADD COLUMN` appends columns; rebuilt tables keep their
quoted names; some CHECK constraints were never added to old tables). Its schema 17 was
never a new ledger's schema 17, so no upgrade could make it a new ledger's schema 18.

**Fix.** The live check compares what the upgrade changes, not where it ends: every object
of the old ledger is unchanged except the three tables that gain the uplink column and the
renamed allowance column, and the new tables and indexes equal a new ledger's
(`private/scripts/ledger-schema18-check.mjs`). The public test still proves that a new
schema-17 ledger upgrades to exactly a new schema-18 one.

## A kept model that froze the local apps

**Symptom.** A few hours after the worker's three lanes went live, the local apps stopped
answering. The website's home page timed out after 15 seconds and a site's list after 8 seconds; a
site's video list took 3.0 s, its changes feed 5.5 s and the pipeline dashboard 3.55 s. The
description lane had spent three hours on one 506-second 1080p recording with the GPU idle,
and llama-server held 24.18 GB of RAM.

**Cause.** Two faults met. The lanes keep the description model loaded between recordings;
before them, llama-server started and stopped for each description, which handed its memory
back every time. Kept loaded, it grew for two reasons: it kept llama.cpp's default prompt
cache in RAM, although every description's prompt is new, so the cache only held memory; and
llama.cpp's video input decoded every frame of a video into RAM before it encoded the first
one, about a thousand raw 1080p frames (some 6 GB) for this recording at 2 FPS. How the
24.18 GB split between the two was not measured. The second fault: the server ran in the same
systemd slice as the batch work, so when the slice passed its `MemoryHigh` (then 70%) the
kernel throttled everything in it, the server included: memory pressure `full` 73.4% and
1,792 socket throttles on that slice. Stopping the hung worker alone, before any code
changed, brought the home page to 57 ms.

**Fix.** llama-server runs with `--cache-ram 0` and requests send `cache_prompt: false`; a
kept server above 10 GiB of RSS starts again before the next description (`descriptor-recycle`
in the log), and a request gives up after 25 minutes. The pinned llama.cpp fork
(`packages/descriptor/runtime/llama-cpp.lock.json`) decodes one frame at a time for models
without temporal merging, Gemma among them, and reaps its ffmpeg and ffprobe children. The
server has its own slice, `video-interactive.slice` (CPU weight 1000, I/O weight 500, 4 GiB
high, 6 GiB max); the batch slice is 65% high, 75% max. Background finalization runs at most
four ffmpeg checks, at nice 10, and segments are served with `sendFile`. On the same
recording, llama-server then stayed at 7.74 to 7.90 GB with the GPU busy, and finished. With
all three lanes busy: the home page 11–18 ms, the video list 12–36 ms, its changes feed
9–25 ms, the site's list 14 ms, the dashboard 222 ms, and the file-host library's list
9–11 ms (161 ms during the incident, 248 ms for its changes feed); memory pressure on the
server's slice 0.00%, with no socket throttles. No test reproduces the growth: the RSS guard
and the separate slice are what keep a model from freezing playback again.

## A repair database that kept every playlist

**Symptom.** In the same investigation, the server's finalization database had grown to
203.2 MB, and every dashboard refresh and worker step scanned whole ledger tables.

**Cause.** The journal of each repaired fMP4 recording kept, after publication, the original
and repaired playlists and a hash of every source segment: what a repair needs until it is
published, not after. 2,685 checkpoints still named folders deleted since. The ledger had no
index for the queries each worker step and dashboard refresh run, and the dashboard counted
its 14 days with one query per day plus one for the last 24 hours: 15 full scans of
`state_events` per refresh. Healthy session keepalive rows were never deleted.

**Fix.** A published journal keeps the repaired playlist's SHA-256 and the output receipts
(version 2), enough to verify the published files on a later pass. A one-time compaction
rewrote the 402 old journals, removed the stale checkpoints and vacuumed: 203.2 MB to
8.2 MB. Ledger schema 19 adds 11 indexes and changes no table; `ANALYZE` ran once after the
upgrade on the live ledger. Healthy keepalive rows older than 30 days are deleted (3,258 at
the first pass); every failure stays. The dashboard reads its 14 days in one pass.
`fmp4CaptureFinalization.test.mjs` checks that a published journal is version 2, with no
playlists or segment hashes, and that a second pass leaves the recording unchanged;
`ledgerSchema.test.mjs` upgrades a schema-18 ledger to exactly a new schema-19 one, and a
SIGKILL in the middle of the upgrade leaves the old ledger whole. How much of the dashboard's
gain came from the indexes and the one-pass query, apart from the end of the memory incident,
was not measured.

## One segment the site never served, and the ones after it

**Symptom.** On one live site, a few times a week, a recording missed 1 to 17 segments in a
row, each time just after a `segment download failed — stopping` warning for a 404: the
site listed a segment in its live playlist and answered 404 for it, on every request.

**Cause.** A 404 ended the capture attempt. The session then waited 5 seconds, asked the
site again and fetched the playlist from the start: 6 to 17 seconds in all, while the
site's live window holds about six seconds. By then the segments after the missing one had
left the window, and requests already made for them were cancelled with the attempt.

**Fix.** A listed segment answered with 404 or 410 is fetched once more on the next poll,
then left out (counted as missed, `SEGMENT-UNAVAILABLE`) while the media after it is saved.
A 404 on the last listed segment, three in a row, or any other refusal still end the
attempt, so a stream that ended or a token that expired gets a fresh start. A gap line now
also names the playlist polls that got no playlist since the last good one: the same site's
playlist answered 404 for 10 to 16 seconds twice in one day, which the line had reported as
a loop that "polled too late". The tests replay a three-segment window that moves every
second with one segment that never answers.

## A kept model started again after nearly every description

**Symptom.** The description model, kept loaded between descriptions, was stopped and
started 36 times in one day (`descriptor-recycle`), each start reading the model from disk
again for 30 to 60 seconds.

**Cause.** Its memory ceiling, 10 GiB, was compared with the process's whole resident set.
A freshly started server already held 9.95 GB of it: 6.05 GB of its own memory and 3.82 GB
of pages mapped from the model files, which are page cache the kernel can take back. Each
description then added up to about 1 GB of its own memory, so one description was enough to
pass the ceiling.

**Fix.** The ceiling counts the memory the server holds, anonymous and shared, not the model
files' pages; the recycle event logs both, and how many descriptions the server served, so
its growth per description can be read from the journal.
