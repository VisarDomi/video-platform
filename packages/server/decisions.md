# Server Decisions

## ENDLIST triggers finalized media-integrity ownership

For Tango/FC2, `#EXT-X-ENDLIST` plus removal from `live-status.json` transfers a
recording from the downloader to the server. The server watches that state
transition and catches up completed folders whose directory changed after the
integrity feature was enabled, covering streams that finish while the server is
offline without enrolling the historical library.

The first integrity check is one strict, single-threaded whole-playlist ffmpeg
decode. Clean streams do not spawn a validator for every segment. If that pass
fails, the server decodes each MPEG-TS segment sequentially to attribute the
failure. The automatic operation writes only `.media-integrity.json`; it never
moves, copies, deletes, or rewrites a segment or playlist. Failed fMP4 playlists
are reported without fragment attribution. Repair and deletion require a
separate explicit user action.

Completed recordings enter one deduplicating FIFO queue with half as many
workers as the host has logical CPUs. Each worker runs one single-threaded
ffmpeg at nice priority 10 and waits 15 seconds between recordings. On the
current 12-CPU host, systemd additionally caps the whole service at 600% CPU,
starts memory reclaim at 70% of physical RAM, hard-limits it at 80%, and denies
swap. Deep scans checkpoint every 25 segments for restart-safe progress.
Null-muxer DTS messages are filtered while stderr is streamed, before its
bounded capture buffer, so a truncated ignored diagnostic cannot become a
false error.

If a user moves a recording while its scan is active, the queue locates the
same finalized folder under that provider's other managed roots and resumes
from the moved checkpoint. A rename must not turn a media result into an
`ENOENT` failure or let a completed stream escape validation.

Playlist duration repair is not part of automatic integrity validation. When
called explicitly, PlaylistAuthority uses adjacent MPEG-TS PTS for ordinary
boundaries and reserves ffprobe for discontinuities, tails, or missing byte
probes instead of spawning ffprobe for every segment.

Validation maps video and audio optionally, so audio-only and video-only media
are both valid inputs. Null-muxer "non-monotonically increasing DTS"
bookkeeping is not media corruption and is not grounds for failure; demuxer,
video-decoder, and audio-decoder errors remain fatal.

Historical folders created before this behavior was enabled are not
automatically decoded. They remain an explicit batch/manual migration so a
server restart cannot unexpectedly launch millions of segment decodes.

## Config paths do not create storage trees

Provider paths are declarative. Server startup does not create
downloader/editor/converter directories for every configured provider. Only the
write operation that actually needs a destination creates it. Converter and
uploader layouts remain uncreated until their pipeline ownership is enabled.

## TL live URL check uses GET, not HEAD

`POST /tl/check-live-url` sends a GET request to tango.me HLS endpoints. HEAD requests are rejected by tango.me CDN. The response body is consumed and discarded to avoid leaking the connection.

## tl provider uses /tmp paths

tl (ephemeral live proxy) stores segments in `/tmp/Videos/downloads/tl/`. These are created on demand by the downloader's API server, not pre-validated at startup.

## Orphan finalizer: structured parse for crash recovery

The non-finalized playlist rebuild parses into header lines + sections (each with a MAP + entries), then serializes back. Handles both MPEG-TS (no MAP) and fMP4 (MAP per quality section). Missing headers are reconstructed. Reads live-status.json to avoid touching dirs with active downloads.

**Why:** The old line-by-line rebuild with positional heuristics produced headerless playlists when the first MAP wasn't in the expected position (power loss during header write).

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
