# Server Decisions

## TL live URL check uses GET, not HEAD

`POST /tl/check-live-url` sends a GET request to tango.me HLS endpoints. HEAD requests are rejected by tango.me CDN. The response body is consumed and discarded to avoid leaking the connection.

## tl provider uses /tmp paths

tl (ephemeral live proxy) stores segments in `/tmp/Videos/downloads/tl/`. These are created on demand by the downloader's API server, not pre-validated at startup.

## mp4 provider uses flat files, not HLS directories

mp4 entries are single files, not HLS segment directories. The retrieve service skips directory scanning for mp4 and returns file metadata directly.

## fMP4 duration: concat protocol fallback

For fMP4 segments, ffprobe can't determine duration from a single segment without the init segment. The server tries probing with the concat protocol (init + segment) first, falls back to reading durations from the existing playlist.m3u8 EXTINF values, then defaults to a fixed duration.

## Segment processing: pLimit(5)

Concurrent segment processing is capped at 5 to avoid overwhelming ffprobe with too many parallel invocations.

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
