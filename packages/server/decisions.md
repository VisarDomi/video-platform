# Server Decisions

## Server promotion defines finalized recording integrity

For Tango, FC2, and SC, the downloader atomically writes `#EXT-X-ENDLIST` and
hands the recording from `.active` to the hidden `.pending` sibling. The server
watches `.pending`, processes the recording there, and alone promotes it into
the visible downloader root after validation passes. Watch-before-scan startup reconciliation and an hourly
non-recursive safety reconciliation cover server downtime and missed/coalesced
events without inspecting segment inventories.

The first integrity check is one strict, single-threaded whole-playlist ffmpeg
decode. Clean streams do not spawn a validator for every segment. If that pass
fails, the server decodes each MPEG-TS segment sequentially to attribute the
failure. Attributable corrupt MPEG-TS entries are removed from the playlist,
the playlist is canonically repaired, the unreferenced files are moved to
desktop Trash, and strict validation runs again. Failed fMP4 playlists are
reported without fragment attribution and remain nondestructively blocked.

Completed recordings enter one deduplicating FIFO queue with half as many
workers as the host has logical CPUs. Each worker runs one single-threaded
ffmpeg at nice priority 10 and waits 15 seconds between recordings. On the
current 12-CPU host, systemd additionally caps the whole service at 600% CPU,
starts memory reclaim at 70% of physical RAM, hard-limits it at 80%, and denies
swap. Deep scans checkpoint every 25 segments in the central
`finalization.sqlite` ledger for restart-safe progress; recording directories
receive no integrity sidecar.
Null-muxer DTS messages are filtered while stderr is streamed, before its
bounded capture buffer, so a truncated ignored diagnostic cannot become a
false error.

Pending recordings are hidden from video operations, so they cannot be moved
while validation is active. The successful same-filesystem rename into the
visible root is the completion record.

PlaylistAuthority is part of the unified finalized-recording processor. It uses
adjacent MPEG-TS PTS for ordinary boundaries and reserves ffprobe for
discontinuities, tails, or missing byte probes instead of spawning ffprobe for
every segment.

Validation maps video and audio optionally, so audio-only and video-only media
are both valid inputs. Null-muxer "non-monotonically increasing DTS"
bookkeeping is not media corruption and is not grounds for failure; demuxer,
video-decoder, and audio-decoder errors remain fatal.

Historical folders created before this behavior was enabled are not
automatically decoded. They remain an explicit batch/manual migration so a
server restart cannot unexpectedly launch millions of segment decodes.
The bounded migration uses the stable `video-finalize-library.scope` unit, so a
second invocation cannot run concurrently and the operator can stop it by a
predictable name. Restarting reuses unchanged successful playlist checkpoints
before cleanup or duration probing; failed MPEG-TS deep scans retain their
25-segment checkpoint granularity. `--recording /exact/managed/folder` restricts
the same processor to one visible immediate downloader/edited recording and is
mutually exclusive with catalogue provider, scope, and limit filters.

Failed-integrity repair removes only validator-attributed MPEG-TS entries, inserts an HLS
discontinuity before the next good segment, publishes the playlist first, moves
the exact corrupt files to desktop Trash, runs canonical duration repair, and
strictly revalidates the result. Publishing the playlist first means an
interruption can leave an unreferenced corrupt file but cannot leave a newly
missing referenced segment. The same idempotent operation serves automatic and
manual retry paths.

## Config paths do not create storage trees

Provider paths are declarative. Server startup does not create downloader or
editor directories for every configured provider; only the write operation
that needs a destination creates it. The unsupported old `converter/converted`
provider path has been removed. The standalone pipeline owns any future artifact
layout explicitly instead of exposing it as an HLS video provider.

## Pipeline trusts the server publication boundary

The standalone pipeline reads only immediate visible downloader/edited entries.
It ignores hidden `.active` and `.pending` roots and does not request redundant
repair or integrity work: visible root membership means the server already
completed both.

## Disk space monitor stops the downloader at 50GB

Server supervises the downloader — stops it via `systemctl --user stop video-downloader` when available disk drops below 50GB.

**Why:** Prevents disk from filling completely, which would corrupt in-progress recordings. Lives in the server so the downloader doesn't need to restart for monitoring logic changes.

## SC room IDs resolved at write-time

resolveScUsername is called once at add-time. The stable numeric room ID is persisted to sc.txt alongside the username. Usernames can change; room IDs don't.

**Why:** Renamed/deleted accounts caused 404s on every poll cycle.

## AliasRegistry is server-only

AliasRegistry lives in the server, not shared. Only the server reads/writes aliases.json — the downloader doesn't touch it. The downloader gets folder names from tango.txt (which the server's alias refresh keeps in sync). The frontend consumes aliases.json via the /api/tango/list endpoint for search across current + historical aliases.

## Alias refresh: hourly batch + tango.txt sync

Hourly cycle: fetch all following IDs (size=5000), batch-fetch aliases (chunked in groups of 500), persist to aliases.json, then rewrite stale alias portions in tango.txt. The downloader's TargetManager picks up tango.txt changes via fs.watch.

## Batch alias endpoint caps at 500

The Tango batch profile API returns at most 500 results per request. The fetcher chunks requests in groups of 500 sequentially.

## Notes

- The API server has HTTP fallback.
- Userscript integration uses API endpoints to manage download lists.
- Userscripts on external sites should use `GM_xmlhttpRequest` or `GM.xmlHttpRequest` to bypass CORS and mixed-content restrictions.
- `.pending` and media validation are capture-only (`downloaded` roots).
  Edited recordings publish directly into `edited/` with a derivation
  checkpoint — never route an edit through the validation finalizer.
