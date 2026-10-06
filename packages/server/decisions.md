# Server Decisions

## Finalization is non-destructive and every recording publishes

For Tango, FC2, and SC, the downloader atomically writes `#EXT-X-ENDLIST` and
renames the recording from `downloaded/.active/` to the hidden
`downloaded/.pending/`. The server watches each `.pending` root directly and
non-recursively (the roots are created at startup), runs a reconciliation scan
after the watches are in place, and repeats it hourly to cover downtime and
missed or coalesced events. Only folders whose playlist ends with ENDLIST are
queued.

Processing a pending recording (`processFinalizedRecording`):

1. Provider sequence restarts (a compound segment name whose sequence does not
   increase) are kept; a missing `#EXT-X-DISCONTINUITY` is added before each
   one and the restarts are reported as a `sequence-restart` warning.
2. PlaylistAuthority repairs `#EXTINF`/`#EXT-X-TARGETDURATION` (below).
3. Media files in the folder that the playlist does not reference are listed as
   an `unreferenced-media` warning and left in place.
4. Validation decodes each native run (segments between discontinuities and
   init-map changes; a single-run playlist is decoded directly) with one strict
   ffmpeg pass. If that fails, MPEG-TS segments are decoded one by one, and fMP4
   fragments alone and then with a same-epoch neighbor, to attribute the
   damage. Attributed segments stay in the playlist and are listed in
   `invalidSegments` with a `damaged-segments` warning; damage no single
   segment explains is an `unattributed-damage` warning; a playlist the
   validator cannot interpret, or validation that cannot complete for a reason
   in the recording, publishes unvalidated with a `validation-incomplete`
   warning.

Finalization may rewrite only `playlist.m3u8` (durations and discontinuity
tags). It never removes a playlist entry and never moves or deletes a media
file.

The report (version 2, validator revision 4) has status `ready` (published,
possibly with `warnings`), `empty` (no playlist entries), or `failed`. `failed`
means only that the validation environment failed: ffmpeg could not start, the
filesystem refused I/O (permission, space, I/O errors), or every segment failed
with a host decoder error. A failed recording stays in `.pending` and is retried
at the next reconciliation. An `empty` recording with no unreferenced media
segments goes to the desktop Trash (`gio trash`); one that still has
unreferenced segments is published. A destructive-repair journal left in the
ledger (`media_repairs`) is cleared without moving files and reported as a
`retired-repair-journal` warning.

Publication is a same-filesystem rename from `.pending/` into the visible
`downloaded/` root followed by directory fsyncs; that rename is the completion
record, and the checkpoint is rewritten under the published path. Pending
recordings are hidden from the video API (only `.active` folders and visible
recordings are listed), so they cannot be moved or edited while being
processed.

**Why:** Captured media cannot be captured again. Dropping or trashing a
segment loses it, and holding back a recording for one bad segment hides all
the rest. Warnings keep the evidence while every recording stays available to
the viewer and the pipeline.

## Finalization checkpoints and stderr handling

Checkpoints live in the central `finalization.sqlite` ledger
(`~/.local/share/video-services/finalization.sqlite`), keyed by recording path
and playlist fingerprint; recording directories get no sidecar. A `ready`
checkpoint for the same fingerprint skips the work; deep scans checkpoint every
25 segments so a restart resumes them.

Validation maps video and audio optionally (`-map 0:v? -map 0:a?`), so audio-only
and video-only media are both valid. Null-muxer "non monotonically increasing
dts" messages are bookkeeping, not corruption: they are filtered while stderr is
streamed, before its bounded 16 KiB capture, so a truncated ignored message
cannot become a false error. Demuxer and decoder errors are failures.

## Finalization exposes work while systemd allocates resources

The pending queue is one deduplicating FIFO with one worker per
`os.availableParallelism()` (cgroup-aware), each pausing 15 seconds between
recordings; PlaylistAuthority probing and the library command use the same
ceiling. This bounds parallel work; it is not a CPU throttle. systemd caps all
processing in `video-processing.slice` (`CPUQuota=600%`, `MemoryHigh=70%`,
`MemoryMax=80%`, no swap) and gives the server `CPUWeight=1000` over the
weight-100 pipeline service and background scopes. Inside the slice Node
reports six available CPUs; outside it, all twelve host CPUs.

FFmpeg receives no thread or priority flags, and the library command has no
`--concurrency` option. Exact `--recording` library finalization runs as
`video-finalize-library-single.scope`, whose systemd drop-in gives it
foreground weight (`CPUWeight=1000`); catalogue finalization runs as
`video-finalize-library.scope` at the default weight.

## PlaylistAuthority derives durations from the media

PlaylistAuthority reads MPEG-TS PTS from the segment bytes and uses the
distance between adjacent video start times for ordinary boundaries. It runs
ffprobe only when the byte probe fails, or when a segment before a
discontinuity or at the tail needs a stream duration the byte probe could not
establish. Where adjacent video PTS cannot provide the timeline, `#EXTINF` is
`max(video duration, audio duration)`; container duration is used only when
neither stream has a positive duration.

**Why:** Some damaged segments contain almost no advancing video while audio
continues, and Safari presents that interval as frozen video with continuing
audio. A video-only duration would make the playlist timeline shorter than what
Safari plays and make time-based editing inaccurate.

## Library finalization is explicit

A server restart never decodes visible recordings: only `.pending` is watched.
Visible recordings are (re)finalized in place by the bounded command:

```bash
npm run finalize-library -w server                    # dry run: counts only
npm run finalize-library -w server -- --apply [--provider tango|fc2|sc|all] [--scope downloads|edited|all] [--limit N]
npm run finalize-library -w server -- --recording "/exact/managed/folder" --apply
```

It runs in a systemd scope inside `video-processing.slice` with a stable name,
so a second invocation of the same kind cannot run concurrently and the
operator can stop it by name. Unchanged playlists with a `ready` checkpoint are
skipped; interrupted deep scans resume from their checkpoint. It processes
folders in place and never publishes or trashes them, and it removes any
legacy `.media-integrity.json` sidecar of a ready recording. A complete
`all`/`all` run without failures records the `historical-finalization-v1`
contract the pipeline checks. `--recording` accepts exactly one visible
immediate child of a managed `downloaded` or `edited` root (not a symlink, with
a regular `playlist.m3u8`) and cannot be combined with `--provider`, `--scope`,
or `--limit`.

## Edited recordings skip the validation queue

`.pending` and media validation are capture-only (`downloaded` roots). An edit
is built from an already finalized recording's segments and published directly
into `edited/` with a `ready` checkpoint recorded by derivation
(`trustedDerivation: "edited-from-validated-recording"`). Never route an edit
through the pending finalizer.

## Pipeline trusts the server publication boundary

The pipeline reads only immediate visible `downloaded`/`edited` folders and
ignores the hidden `.active` and `.pending` roots. It requires a `ready`
version-2 checkpoint whose fingerprint matches the current playlist, treats a
report with warnings like any other ready report, and never asks the server to
repair anything.

## Config paths do not create storage trees

Provider storage paths come from `providerFolders()` in `packages/shared`
(`<downloads root>/<provider>/<downloaded|edited|trash>`). Importing the server
config creates no provider storage directories (`test/configPaths.test.mjs`);
it creates only the frontend build directory, the download-lists directory, and
the shared state directory when missing. At startup the finalizer creates the
three `downloaded/.pending` roots it watches. Every other destination is
created by the write that needs it.

## Disk space monitor stops the downloader at 50 GiB

Every minute the server checks the free space of the filesystem holding the
downloads root and runs `systemctl --user stop video-downloader` when less than
50 GiB is available. It never starts the downloader again.

**Why:** A full disk corrupts in-progress recordings. The check lives in the
server so changing it never restarts the downloader.

## SC room IDs resolved at write time

Adding an SC streamer resolves the username once (`resolveScUsername`) and
stores the stable numeric room ID next to it in `sc.txt`
(`https://stripchat.com/<username> <roomId>`). Membership and removal resolve
names to room IDs. An hourly refresh asks Stripchat for the current usernames of
all listed room IDs (100 per request) and rewrites changed usernames in
`sc.txt`.

**Why:** Usernames change; room IDs don't. Polling by a stale username fails on
every cycle.

## AliasRegistry is server-only

AliasRegistry lives in the server. Only the server reads and writes
`aliases.json`; the downloader takes folder names from `tango.txt`, which the
server's alias refresh keeps in sync. `GET /api/tango/list` returns each listed
streamer's ID with its current and historical aliases.

`aliases.json` writes take a directory lock (`aliases.json.lock`,
`services/fileLock.ts`): `mkdir` is atomic, and `holder.json` inside records
the holder's PID and timestamp. A holder older than 30 seconds or whose PID is
not alive (`kill(pid, 0)`) is stale and removed at once; an unreadable holder
(mid-creation) is retried every 50 ms, up to 5 seconds.

## Alias refresh: hourly batch + tango.txt sync

Every hour (and at startup) the server collects the followed account IDs
(`size=5000`) plus every account in `tango.txt`, fetches their profiles from the
Tango batch profile API in sequential chunks of 500 (the API's per-request
maximum), persists the aliases to `aliases.json`, then rewrites stale aliases in
`tango.txt`. The downloader's target manager picks up the change through its
directory watch.

## Notes

- The API server uses HTTPS with the mkcert certificate in
  `~/.local/share/mkcert/pwa/` and falls back to HTTP when it is missing.
- The FC2/SC live extensions and the viewer's +/- button drive the download
  lists through the `/api/{provider}/member|exists|add|remove` endpoints; the
  extensions send these requests from their background page, so page security
  policies never apply.
