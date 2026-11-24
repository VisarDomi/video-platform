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
