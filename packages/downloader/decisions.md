# Downloader Decisions

## `.active` plus recording identity owns restart recovery

The downloader writes each recording under
`<downloads root>/<provider>/downloaded/.active/<YYYY-MM-DD HHMMSS alias>/`
(local time, chosen by the application). The recording identity is Tango
`streamId`, FC2 `start_time`, or Stripchat `statusChangedAt`; a public stream
without one is refused. Segment files are named
`<local number>_<recording identity>_<provider sequence>.ts`. A UTC identity
keeps the provider's `Z` but drops the colons (`2026-08-12T09:08:47Z` is stored
as `2026-08-12T090847Z`); provider snapshots and parsed filenames use the same
canonicalizer, and URI percent escapes are never stored in filenames. Legacy
numeric filenames are readable but never guessed as a resumable identity.

Shutdown and transport/API failures leave the folder in `.active` without
ENDLIST. Provider snapshots decide whether it resumes or ends: the same
recording identity resumes, a different identity or an upstream ENDLIST ends
it at once, a Tango live-playlist HTTP 404 ends it, and an absent/non-public
streamer ends it only after two observations at least 60 seconds apart with no
playlist progress. An unavailable provider response never ends a recording.

At startup each `.active` folder is inspected: one that already has ENDLIST is
handed off, one without any media goes to the desktop Trash, a legacy folder
(no compound segment names) is finalized and handed off without guessing an
identity, and a folder mixing identities is left untouched with a warning.
While running, the periodic scan hands off an ENDLIST folder only when no
session owns it; a session hands off its own folder after writing ENDLIST.

`live-status.json` is runtime display state only; lifecycle never reads it.

**Why:** Process restarts and CDN failures are not evidence that a broadcast
ended; only the provider's own state is.

## ENDLIST transfers finalized-media ownership to the server

The downloader owns transport and the active playlist append only.
`PlaylistManager.finalizePlaylist()` atomically writes `#EXT-X-ENDLIST`
(correcting `#EXT-X-TARGETDURATION`), then the folder is renamed from
`downloaded/.active/` to the hidden `downloaded/.pending/` and the directories
are fsynced. That rename is the durable handoff. The server alone validates the
media, marks numbering restarts, repairs durations, and publishes the recording
into the visible `downloaded/` root.

**Why:** Transport success and media decodability are separate concerns, and
full decoding belongs after the stream is complete.

## Provider sequence baseline and numbering restarts

A segment's provider sequence is `#EXT-X-MEDIA-SEQUENCE` plus its position in
the window, not the number in its URI. The baseline is the sequence of the last
saved (or abandoned) segment of the current numbering run; on resume it is the
sequence of the playlist's last entry (the tail), not the maximum. A segment is
new media when its sequence is above the baseline.

A window whose newest sequence lies more than (window length + 10) below the
baseline (`SEQUENCE_RESTART_MARGIN_SEGMENTS`) is a provider numbering restart:
the whole window is accepted as new media, its first segment gets
`#EXT-X-DISCONTINUITY`, a `SEQUENCE-RESTART` warning is logged, and the
baseline drops to the new run. A window closer than that is a stale or lagging
copy of the same numbering and is deduplicated.

A window whose first sequence lies more than one above the baseline (outside an
edge switch) has lost the segments between: they left the live window before a
poll listed them. `SEQUENCE-GAP` names them with the window and the time since
the previous poll. More than 3 seconds (or a first poll after a restart) means
this loop fell behind: a warning. Less means the provider skipped them, as when a
streamer's feed stalls and the window restarts small: an info line, since nothing
here can recover them. The session's "recording ended" line counts every missed
provider segment.

The appended entry also gets a discontinuity after any sequence gap, a change
of TS dimensions/SAR (unknown dimensions count as a change), a new init map, or
a resume.

**Why:** Providers restart their numbering mid-recording (SC edges number
independently, Tango restarts at 0, FC2 has gone from 1112 to 1). A baseline
that only grows would skip every later segment until the counter passed the
old maximum.

## Received media is never deleted

An empty response body is not written. A written file that the provider's
validator cannot read stays on disk. Either way the segment is not handled: the
batch stops (later segments wait, keeping playlist order) and the next poll
fetches it again while the live window still lists it. After 5 rejections
(`REJECTED_SEGMENT_MAX_ATTEMPTS`) it is abandoned with a warning, the baseline
moves past it, and the next saved segment gets a sequence-gap discontinuity.
An upstream ENDLIST is acted on only after a pending refetch is resolved.

Validators: Tango and FC2 require a nonempty file and probe its dimensions with
ffprobe; unknown dimensions keep the segment with an input boundary. SC requires
a readable fragment whose index addresses only its own mdat and lists no
zero-size sample, and takes the duration from the fMP4 fragment.

SC fragments are repaired as they arrive. A source stall can leave a sample
entry of zero bytes (an empty video frame) in a fragment's index; ffmpeg refuses
such a fragment, and Safari stops playback ("Cannot Parse") as soon as it reads
that far ahead, about 70 seconds before the fragment. The session drops each
such entry, gives its duration to the sample before it (or moves the track's
`tfdt` when it was the first), and adjusts the box sizes, data offsets and
`sidx` sizes. Every media byte stays, and only the repaired fragment is written;
the saved segment logs `repaired segment … dropped N zero-size sample entries`.
A layout the repair does not rewrite, or any other index damage, fails
validation.

On resume, files written after the playlist tail before an interruption are
re-appended in local-number order when they are nonempty, readable, do not
repeat the tail's provider sequence, and (for fMP4) have their init map on disk;
live capture then starts after a discontinuity. Every other unreferenced file
stays on disk for the server to report. A torn line after the last valid entry
is trimmed atomically; a playlist with legacy, mixed, or foreign names refuses
to resume.

**Why:** Bytes received from a live stream cannot be fetched again later. Any
judgement about damaged media belongs to the server, which keeps it too. An
empty frame entry carries no media, so dropping it loses nothing and keeps the
fragment readable by players and the pipeline.

## Capture keeps every resolution

Tango selects the master variant with the most pixels (then bandwidth),
including portrait variants and low-resolution-only streams, and uses a media
playlist served in place of a master directly. Every resolution is kept,
including 360p. Upstream EXTINF stays provisional while the stream is live:
Tango and FC2 keep it, SC uses the fragment duration. TARGETDURATION is raised
whenever a segment needs it.

## StreamSession owns the recording lifecycle

One session = one folder. StreamSession owns DiskSession, PlaylistManager,
InitTracker, and the retry loop. StreamDownloader is a single download attempt
that receives these as inputs; it doesn't create, finalize, or remove anything.

After each attempt exits, the session may use the latest successful provider
snapshot to resolve a fresh URL, but it does not infer completion from
transport failure. Shared snapshot reconciliation owns the recording lifecycle:

- **SC:** bulk status (`public` and `isLive`) every 5 seconds, plus
  `statusChangedAt` from the cam detail API, re-read once a minute while a
  streamer stays live.
- **Tango:** bulk account lookup with `streamId`, restricted to `tango.txt`,
  once a second. File replacements reload targets (the directory is watched),
  and a new recording identity replaces even a session with an empty or missing
  folder. A live-playlist HTTP 404 ends the session; authentication, network,
  and server failures remain retryable, polled again after 1 second
  (`playlistRetryMs`; other providers wait 5 seconds) because the live window
  holds only six one-second segments. A run of 401s logs one error and one
  recovery line. The master is used only to select the
  initial live URL: master failures never end a recording, and polling and
  retries keep the selected live URL without refreshing the master.
- **FC2:** the adult all-channel list (`allchannellist.php`) with `start_time`,
  requested at most once per 30 seconds.

**Why:** A folder per download attempt would split one broadcast into many
folders at every CDN edge rotation and lose the media between them.

## Sessions end when their streamer is removed or offline without media

Every provider poll first ends the sessions of streamers no longer in the
download list (`ActiveRecordingReconciler.endRemovedSessions`), even when the
provider lookup fails or the list is empty; recorded media is handed off. A
session that has not recorded any media ends once the provider has reported its
streamer offline over two observations at least 60 seconds apart. Sessions with
a folder follow the folder rule above.

**Why:** A session retries until something ends it, and the folder scan only
judges folders: it cannot see a session without media, nor one whose streamer
left the list. A playlist URL can keep answering 200 after its streamer goes
offline.

## Discovery normalizes to session candidates

Provider discovery code owns only provider-specific knowledge: target parsing,
status APIs, public/paid rules, stream-name refresh, and master URL derivation.
Once a provider has a candidate (`streamerId`, `alias`, `recordingId`,
`masterPlaylistUrl`, optional resume folder), `startStreamSession` owns the
common lifecycle: add to `DownloadsManager`, create `StreamSession`, register
abort/finalize/completion, and update zero-segment cooldown state.

**Why:** One writer for download lifecycle registration keeps logs and
cooldowns consistent across providers.

## Download loop: only the loop changes its state

Recovery runs inline in the download loop. Tango never checks the master during
capture. SC and FC2 re-check the master every 10 seconds; the check runs beside
polling and only returns an answer, which the loop applies at the top of its
next iteration if the live URL is still the one checked, logging a different
selection as `VARIANT_CHANGE`. SC also tries variant recovery when the live
playlist fails. Sixty seconds without a saved segment exit the attempt (30
seconds logs `STALE`, a debug line); non-terminal exits retain the recording for
retry.

A playlist request that has not answered within a second gets a second, identical
request (`PLAYLIST_HEDGE_MS`); the first answer is used and the other is aborted.
An aborted request records no failure.

Segments of a poll are fetched four at a time and saved in playlist order. While
the loop waits more than a second for a segment, it polls the live playlist again
and queues what the window newly lists behind the batch (`POLL_WHILE_WAITING_MS`).
That poll runs only while the loop waits, never beside an append; a playlist that
fails, ends, changes its init map or restarts its numbering there is left to the
next regular poll, after the batch is saved.

**Why:** A timer running beside the loop can act on state the loop has already
left, so nothing beside the loop changes its state: the loop applies a check's
answer itself and drops a stale one. Tango and SC list about six seconds of
media, so one slow segment download, or one master or playlist request that
stalls for 5–10 seconds while a fresh request answers at once, would otherwise
let segments leave the window before the loop polls again. A Tango request that
stalls also outlives its 10-second stream token and comes back 401.

## Segment fetches: network errors and 429 retry, other HTTP errors stop

`fetchSegment` returns `{ data, retryable, status?, error? }`. Up to four
segment fetches run concurrently within each playlist batch. Network errors,
timeouts and HTTP 429 retry the same segment after one second while other
workers fetch later segments; playlist appends stay in source order, and a retry
never marks the segment handled. The 60-second inactivity limit and shutdown
still end the attempt, after which the session retries from the live playlist.
Any other HTTP error stops the attempt. A live playlist answering 429 is polled
again after 2 seconds, without variant recovery.

**Why:** A transient network failure should neither end the recording nor
advance past media that has not been downloaded. SC's CDN rate-limits in busy
hours (several 429s most evenings); stopping the attempt then waited 5 seconds,
long enough for the segment to leave its six-second window.

## No silent recovery: what changes the recording is a warning

Recovery from CDN failures is allowed, and its effect on the media is never
silent. At the default level a recording logs two info lines, `recording started
in <folder>` and `recording ended (<reason>), <n> segments handed to the server
in <folder>`, plus `VARIANT_CHANGE`. Warnings are what changed or risked the
media: `EDGE-GAP`, `SEQUENCE-GAP` from a late poll, `SEQUENCE-RESTART`, `EDGE-DEDUP bypassed`, segment
rejections, re-appended media, unknown dimensions, a session without segments.
Routine mechanics are debug lines (`LOG_LEVEL=debug`): discovery decisions,
`START`, `STALE`/`RECOVERED`, `EDGE-SWITCH`, `EDGE-DEDUP` skips, `LOOP-EXIT`,
session retries, per-fetch failures that a retry absorbs.

Repeated HTTP failures are aggregated into one access incident spanning
retry-created sessions: one `ACCESS_INCIDENT_OPEN` warning carrying the SC
evidence snapshot, and one `ACCESS_INCIDENT_CLOSE` with duration and counts;
recovery candidates that never work stay at debug level.

The SC evidence snapshot is observational and does not change download
behavior. It records a fresh cam status, the complete master variant ranking,
the selected and next-lower variants, and bounded probes of the selected
variant on two CDN TLDs plus the next-lower variant. Variant URLs are
represented by paths and metadata; Mouflon query keys are not logged.

After an edge switch, a re-listed segment is skipped as a duplicate only when
its program date-time is not newer than the last saved one and within 60
seconds of it (`EDGE_DEDUP_MAX_OVERLAP_MS`). Instants are compared, not
strings; unparseable values never skip anything.

**Why:** Invisible self-healing masks root causes, while logging every retry
buries them. Transition-scoped evidence keeps the proof (public or not, which
qualities were denied, whether a lower variant worked) with low noise.

## Nothing on disk until first byte write

DiskSession creates the folder only when the first segment or init byte is
ready to be written; the informational `live-status.json` view is updated then.
Lifecycle and completion never depend on that file.

**Why:** A folder created for a variant that never delivers is an empty
recording without a playlist.

## InitTracker owns init-file atomicity

`currentMapUri` advances only after the init file is written. Init files are
created exclusively, never overwriting: `init.mp4`, then
`init_<next local number>[_<n>].mp4` for each later map, and every resume writes
a new init boundary.

Only a taken name moves on to the next suffix. Any other write failure (the
folder is gone, the disk is full) ends the attempt, and a session whose folder
has disappeared ends with one error instead of retrying.

**Why:** Advancing the map before a confirmed write would make a failed init
write permanent. A write into a missing folder can never succeed, so retrying it
only floods the log.

## PlaylistManager buffers init-map changes

`bufferQualityChange()` holds `#EXT-X-DISCONTINUITY` + `#EXT-X-MAP` boundaries
until the next segment is appended; on a new playlist they are written together
with the header.

**Why:** Appending a boundary before the header exists would create the
playlist without a header, and writing the header would then destroy the
boundary.

## Graceful shutdown: abort without finalization

On SIGTERM/SIGINT, `DownloadsManager.shutdownAll()` aborts all active sessions
and awaits their completion. From then on no session starts, although discovery
keeps polling. The folders remain under `.active` without ENDLIST so the next
process can compare recording identity and resume.

**Why:** Process shutdown is not evidence that the remote broadcast ended. A
session started during shutdown would resume a folder its stopped predecessor
just left and be cut off mid-write by the exit, while the next process resumes
the same folder.

## The server serves the playlist as written

The server's HLS route returns the playlist file as it is on disk: no
serve-time generation, healing, or TARGETDURATION repair. The downloader owns
active append correctness; the server's finalizer owns everything after the
`.pending` handoff.

**Why:** A serve-time healer hides capture bugs, and invented durations break
iOS Safari playback.

## SC bulk status uses `isLive`, not `isOnline`

A streamer is recordable when the bulk API reports `status: "public"` and
`isLive`. `isOnline` is `false` for some actively broadcasting streamers.

## SC selects the highest-bandwidth named variant, including source

Every master variant with a `RESOLUTION`, including `NAME="source"`, competes
on bandwidth; the best unnamed (auto) variant is used only when no named one
exists. `source` is the broadcaster's own feed and downloads with the same
Mouflon parameters as the transcoded variants.

Selection logs carry the variant name, resolution, bandwidth, and whether it is
the master's best. A different URL is logged as `VARIANT_CHANGE`, not assumed to
be an upgrade, because edge moves and source-resolution changes also change the
URL or init map.

## FC2 skips paid streams

The adult channel list marks paid streams with `pay != 0`. Only entries with
`pay == 0` are recorded; a paid or absent channel counts as not live.

**Why:** A paid broadcast can be live while its HLS WebSocket handshake stays
unavailable without payment.

## No token cache: read from disk on every request

The Tango client reads tokens through `readTokens()` (`packages/shared`), which
reads the session file on every call. There is no watcher and no cache.

**Why:** Stream tokens live 10 seconds and are refreshed every 5. Any cache age
is subtracted from the time left for the request; a disk read is cheap next to
the network fetch that follows.

## Named timing constants

Loop and polling timings are named constants in `src/common/timing.ts`.
Thresholds that belong to one rule are named next to it
(`SEQUENCE_RESTART_MARGIN_SEGMENTS`, `EDGE_DEDUP_MAX_OVERLAP_MS`,
`REJECTED_SEGMENT_MAX_ATTEMPTS`, the reconciler's `TERMINAL_CONFIRMATION_MS`).

## Flat cooldown, no exponential backoff

A session that ends with 0 segments puts its streamer in a 20-second cooldown.

**Why:** Exponential backoff would let one transient failure grow into
minutes-long gaps in a live recording.

## Rule

- Keep downloader concerns separate from server/API concerns.
