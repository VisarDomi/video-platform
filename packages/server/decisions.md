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
