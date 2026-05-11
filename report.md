# HLS Segment Timeline Investigation

Date: 2026-05-11

## Executive Summary

The mismatch was not fixed by using ffprobe `format.duration`; that reproduced the bad playlist clock. The working fix is to make `playlist.m3u8` itself the authoritative HLS media timeline and write `#EXTINF` from the playable media timeline Safari uses: video PTS advancement within a continuity section, falling back to stream duration at a discontinuity or tail segment.

There are two jobs:

- Historical repair: server `PlaylistAuthority` probes existing `.ts` files, rewrites `playlist.m3u8` atomically, recomputes target duration, and reports probe/missing-file failures in logs/API output.
- Future correctness: downloader validation must stop passing MPEG-TS container `format.duration` into `PlaylistManager`. For Tango/FC2 it now uses video stream duration first, then audio stream duration, with format duration only as a fallback.
- Historical repair is now byte-first for `.ts`: it reads MPEG-TS PES PTS timestamps and uses `firstVideoPts(next) - firstVideoPts(current)` for normal adjacent segment durations, falling back to ffprobe only where bytes cannot define the duration cleanly.

## Observed Evidence

Recent logs did not contain a fresh user edit from the last four hours, but the last two days contain repeated evidence of manifest/browser timeline disagreement.

- `2026-05-10 170206 26780549`: playlist duration `3044.452s`, browser media duration `3001.593s`, delta `42.859s`. The frontend used global scale `1.014278586347046` and kept `2189.ts` through `2917.ts`.
- The edited result for the same file later logged playlist duration `769.828s`, browser media duration `741.764s`, delta `28.064s`.
- `2026-05-10 154225 26780549`: playlist duration `2383.388s`, browser media duration `2319.512s`, delta `63.876s`.
- `2026-05-10 014252 nektarinka`: playlist duration `824.078s`, browser media duration `795.053s`, delta `29.025s`.
- `2026-05-10 070628 elliiieeee`: playlist duration `497.870s`, browser media duration `481.529s`, delta `16.341s`.
- `2026-05-10 234043 milkyway999` had a fetched playlist with `segments:0`, `bytes:15`, and the file is just `#EXT-X-ENDLIST`. That is a separate playlist-corruption/empty-recording clue.

The decisive sample was `/home/visar/Videos/downloads/tango/editor/edited/2026-05-10 235819 milkyway999`:

- Old `#EXTINF`/format total: `2247.684252s`.
- Video stream total: `2127.746011s`.
- Audio stream total: `2123.703008s`.
- Rewritten playlist total from video PTS advancement: `2127.729645s`.
- The existing edit discontinuity `433.ts -> #EXT-X-DISCONTINUITY -> 438.ts` was preserved.
- After the rewrite, logs showed `playlist-fetch totalDuration=2127.729645`, native duration/seekable end around `2127.729s`, playback reached `2137.ts`, and the terminal verdict was `playback-ended-confirmed`.

Before the rewrite, logs showed `native-ended-rejected` around `2126.ts`/`2128.ts` with `9-12s` of playlist time remaining. After the rewrite, the remaining time at terminal was about `-0.051s`, which is inside normal boundary tolerance.

Follow-up byte-probe validation on the same file showed:

- `2126` adjacent durations compared from `.ts` bytes.
- `0` mismatches against the repaired playlist.
- Total comparable delta: `0`.
- Full repair check used `2128` byte probes and only `2` ffprobe fallbacks.
- Runtime was under one second on the local machine, instead of roughly a minute with one ffprobe process per segment.

## Current Code Findings

The frontend currently applies one global scale:

- `packages/app/src/lib/services/hls.ts` computes `playbackToPlaylistScale = playlistDuration / playbackDuration`, scales marker ranges, and chooses every segment whose manifest interval overlaps the scaled range.
- `packages/app/src/lib/engine/PlaybackTimeline.ts` does the same for the current `.ts` badge: `playlistTime = playbackTime * scale`, then binary-searches manifest segment intervals.

That cannot be frame-accurate when drift is local or discontinuous. A single scale can align endpoints while moving intermediate boundaries to the wrong segment.

Playlist ownership was split:

- `packages/downloader/src/services/download/playlistManager.ts` writes/appends `playlist.m3u8` while downloading, can rewrite target duration, and finalizes with `#EXT-X-ENDLIST`.
- `packages/server/src/services/orphanStreamFinalizer.ts` can rewrite orphan playlists during recovery.
- `packages/server/src/services/video/edit.service.ts` creates edited playlists by filtering original manifest text and writing a new `playlist.m3u8`.

That was functional but not tight enough. The new boundary keeps `playlist.m3u8` canonical while making the duration source explicit:

- Downloader writes future accepted segments with media stream duration, not container duration.
- Server `PlaylistAuthority` owns historical/batch repair and uses byte-derived video PTS advancement first, with ffprobe fallback only when needed.
- Frontend logs native/media disagreement but does not patch around it.

## Reference Implementations Checked

Cloned under `/home/visar/Documents/reference`:

- `hls-playlist-generator`: derives segment lengths from keyframes and duration, using ffprobe/mp4/mkv keyframe extraction, then writes `#EXTINF` from calculated segment lengths.
- `hls.js`: keeps fragment metadata separate from decoded elementary stream timing. A fragment has manifest duration/start, but parsed media can later attach `startPTS`, `endPTS`, `startDTS`, and `endDTS`.
- `hls-playlist-parser`: simple parser/editing library. Useful as a warning: it preserves and edits tags, but it does not solve media truth.
- `FFmpeg`: HLS muxer uses actual segment entries with durations, target duration from segment durations, temp-file playlist publication, and warnings when packet duration is missing or imprecise.

Useful source references:

- FFmpeg docs: `hls_time` cuts on the next keyframe after target time; `split_by_time` can improve irregular keyframe behavior but can worsen seeking; `temp_file` writes playlists to a temporary file and renames after complete.
- FFmpeg source: `hlsenc.c` writes playlist entries from stored segment durations and publishes temp playlist files with rename for file protocol.
- hls.js source: fragment objects have manifest `duration`, then decoded `startPTS/endPTS` and `startDTS/endDTS` can be attached after transmuxing.
- hls-playlist-generator source: keyframes are extracted with ffprobe and converted into segment lengths before playlist writing.

External links:

- https://github.com/advplyr/hls-playlist-generator
- https://github.com/video-dev/hls.js
- https://github.com/Eyevinn/hls-playlist-parser
- https://github.com/FFmpeg/FFmpeg
- https://ffmpeg.org/ffmpeg-formats.html
- https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis

## Architectural Conclusion

The next fix should not make the overlay smarter. The overlay is correctly dumb. The weak boundary is playlist ownership and validation.

The durable shape is:

1. `playlist.m3u8` stays the source of truth.
2. `#EXTINF` must use media timeline duration, not TS container duration.
3. `playlist.m3u8` is the source of truth, not a generated view of another file.
4. Edits derive a new `playlist.m3u8` from already-canonical source playlist entries, preserving HLS tags and recalculating target duration.
5. Validation problems are surfaced in logs and API responses: missing segment, probe failure, duration disagreement, empty playlist, invalid fMP4 map, or rewrite skipped.
6. The frontend parses the server-owned playlist and uses it to surface mismatch evidence instead of auto-healing native-ended events.

## Open Questions

- For `.ts` badge accuracy, do we want "segment selected by media element currentTime" or "segment currently loaded/decoded by hls.js"? These are not always identical around boundaries. If the goal is "same visible frame, same `.ts`", hls.js fragment/PTS events are likely better than currentTime scaling.
- For old downloads, should the server lazily validate/probe on first explicit repair request, or should a migration/repair job rewrite playlists in the background? Lazy probing is safer for local compute but means old playlists remain uncorrected until touched.
- For live recordings, should the downloader probe every segment immediately after download, or keep provider `#EXTINF` during live capture and run a final authoritative pass at finalization? The second option is cheaper during active downloads.
