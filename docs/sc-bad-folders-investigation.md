# The Ghost Process: Debugging Phantom Download Folders

## The Bug

When downloading live streams via the SC provider, the downloader would create one "truth" folder (with hundreds of `.ts` video segments accumulating over time) alongside dozens of empty "bad" folders — one appearing every ~95 seconds — each containing nothing but a `playlist.m3u8` with a single `#EXT-X-ENDLIST` tag. The truth folder would keep growing normally while the bad folders piled up.

```
2026-02-16 163558 _YUI_CHAN_ — 534 .ts  (truth, actively growing)
2026-02-16 163615 _YUI_CHAN_ — 0 .ts    (bad)
2026-02-16 163750 _YUI_CHAN_ — 0 .ts    (bad)
2026-02-16 163925 _YUI_CHAN_ — 0 .ts    (bad)
... 17 more bad folders ...
```

This happened for every active SC streamer simultaneously.

## The Architecture

The SC provider has a unique capture pipeline compared to other providers (FC2, Tango). Instead of downloading HLS segments directly from a CDN, it:

1. Launches a **headful Chromium browser** via Playwright (running on a virtual display via `xvfb-run`)
2. Uses **MediaRecorder** in the browser to capture the `<video>` element as WebM chunks
3. Pipes those chunks via base64 through a Node.js bridge to **FFmpeg's stdin**
4. FFmpeg outputs **HLS segments** (`.ts` files) to a temp directory (`/tmp/sc_capture_{channel}/`)
5. The **StreamDownloader** loop polls this temp directory, reads new segments, and copies them to the final download folder

The process is managed by pm2 and launched via: `xvfb-run -a -s '-screen 0 1920x1080x24' node dist/main.js`

## The Wrong Theories

### Theory 1: FFmpeg's `-hls_flags delete_segments`

FFmpeg was configured with `-hls_flags delete_segments` and `-hls_list_size 10`, creating a sliding window of 10 segments in the temp directory. The hypothesis: FFmpeg deletes old segments before the download loop reads them, causing `getTsSegment()` to return null.

When `getTsSegment()` returns null, the code hits a `break` — exiting the segment processing loop. If this happens on every iteration (always trying the oldest, already-deleted segment first), `lastDownload` never updates, and after 60 seconds the stale timeout kills the download. A new download starts, creates a new folder, encounters the same race, and the cycle repeats.

**Why it was plausible**: The ~95-second cycle matched perfectly — 60s stale timeout + ~35s for discovery round-robin + isOnline API check + parseMasterPlaylist.

**Why it was wrong**: We added logging and observed that the download loop had `staleSec=1` and `failures=0` on every heartbeat. Segments were being downloaded successfully and continuously. The code was working fine.

### Theory 2: Session Cleanup Race Condition

The ScClient runs a `_cleanupStaleSessions()` every 30 seconds, killing browser sessions not accessed in 60 seconds. The hypothesis: a timing gap where the session is briefly considered stale could cause `getLiveList()` to return `{success: false}`, incrementing `consecutiveFailures`.

**Why it was wrong**: The download loop calls `_touchSession()` on every `getLiveList()` invocation (~every second), keeping the session permanently fresh. The 60-second stale threshold was never reached.

### Theory 3: DownloadsManager Race in Discovery

The ScDiscoveryService has two `hasStreamer()` checks with an async `isOnline()` HTTP call between them. The hypothesis: the truth download's handle could be removed between checks, allowing a duplicate download to start.

**Why it was wrong**: This requires the truth download's handle to actually be removed. But the handle is only removed when `StreamDownloader.start()` exits (after the while loop). If the download is healthy (which logging confirmed), the handle stays in the map.

## The Impossible Contradiction

During live observation, we caught something that broke all theories:

```
17:06:14  ts=607  in_status=YES  folders=24    <- handle exists
17:06:18  ts=608  in_status=NO   folders=24    <- handle GONE
17:06:22  ts=609  in_status=NO   folders=24    <- still writing segments!
```

The truth download's handle disappeared from `live-status.json` (meaning it was removed from DownloadsManager), yet `.ts` files **continued appearing** in the truth folder. This is impossible in a single-process model — `downloadHandle.remove()` is only called after the while loop exits, and if the loop exited, no more segments would be written.

We spent considerable time trying to explain this within the code:
- Could the while loop somehow continue after `remove()` is called? No — `remove()` is after the loop.
- Could a second download be writing to the same folder? No — each download creates a unique timestamped folder.
- Could the Map entry be removed externally? No — only `DownloadHandle.remove()` calls `DownloadsManager.remove()`.

## The Real Cause

After adding `[SC-DEBUG]` tagged logging with a filter (`SC_DEBUG=1` env var to suppress all non-debug messages), we restarted the downloader and immediately saw something in the pm2 logs:

```
19|video-d | 17:18:43 info: [SC-DEBUG] START Sayuringo_ dir=171843...
10|video-d | 2026-02-16 17:19:14 info: Finalizing playlist: .../171814 Sayuringo_
10|video-d | 2026-02-16 17:19:41 info: [SC] Channel Sayuringo_ is LIVE. Starting download...
10|video-d | 2026-02-16 17:19:43 info: .../171943 Sayuringo_ started downloading segments.
```

**Two different process IDs** — `10` and `19` — both named `video-downloader`, both writing to the same log file, both checking the same streamer list, both trying to download the same streams.

Confirmed with `pgrep`:

```
PID 1638459 node dist/main.js    <- new process (pm2 id 19)
PID 2672278 node dist/main.js    <- orphaned old process (5 days old!)
```

### How the orphan survived

The pm2 start command runs: `xvfb-run -a -s '...' node dist/main.js`

pm2 manages the **bash shell** that runs this command. The actual process tree is:

```
pm2 -> bash -> xvfb-run -> node dist/main.js
```

When `pm2 delete video-downloader` runs, it sends SIGTERM to bash. Bash dies. But `xvfb-run` and its child `node` process can survive as orphans — reparented to PID 1 (init/systemd). The `node` process doesn't receive the signal and keeps running indefinitely.

### Why this creates bad folders

With two independent Node.js processes, each has its own `DownloadsManager`:

1. **Process A** (orphan): Detects Sayuringo_ is live, creates download, writes segments to folder X
2. **Process B** (current): Also detects Sayuringo_ is live, also creates download, writes to folder Y
3. Both share the **same ScClient session** (Playwright + FFmpeg) since there's only one set of browser processes on the Xvfb display
4. One process "wins" and keeps getting segments. The other gets stale-timeout (its `getTsSegment()` calls return null because FFmpeg's `delete_segments` removed them before it could read). The loser creates a bad folder with just `#EXT-X-ENDLIST`
5. The loser's handle is removed from its own DownloadsManager. Its discovery loop picks up the streamer again. A new bad folder is born. Repeat every ~95 seconds.

## The Fix

The `npm run restart` script was changed from:

```json
"restart": "npm run build && pm2 delete video-downloader && pm2 start ..."
```

To:

```json
"restart": "npm run build && pm2 delete video-downloader 2>/dev/null; pkill -f 'xvfb-run.*node dist/main.js' 2>/dev/null; pkill -f '^node dist/main.js$' 2>/dev/null; sleep 1 && pm2 start ..."
```

After `pm2 delete`, we explicitly `pkill` any surviving `xvfb-run` or `node dist/main.js` processes, then wait 1 second before starting fresh. This ensures the entire process tree is dead before the new instance launches.

## Verification

After killing the orphan process and restarting with only the current pm2-managed process:

```
17:22:42 truth_ts=74  total_folders=4
17:22:52 truth_ts=78  total_folders=4
17:23:02 truth_ts=80  total_folders=4
...
17:25:52 truth_ts=133 total_folders=4  <- 3+ minutes, no new bad folders
```

The truth folder grew steadily. Zero new bad folders appeared. The bug was entirely caused by the ghost process.

## Follow-up: OrphanStreamFinalizer Gap

After resolving the ghost process, we noticed SC had accumulated dozens of empty folders while Tango appeared clean. The reason: `OrphanStreamFinalizer` only processed `["tango", "fc2"]` — SC was never in the cleanup list.

The finalizer runs every 24 hours and deletes empty folders (0 `.ts` files) plus syncs playlists for non-empty orphaned folders. Adding `"sc"` to the list was a one-line fix.

We initially tried auto-discovering provider directories instead of hardcoding, but caught a gotcha: the `mp4` provider (future, not yet implemented) stores `.mp4` files, not `.ts` segments. The finalizer's delete condition checks for `tsFiles.length === 0` — a folder full of `.mp4` files would be seen as "empty" and deleted. So we kept the explicit list: `["tango", "fc2", "sc"]`. Future providers using `.ts` segments can be added; providers with different formats need their own cleanup logic or the finalizer needs to be made format-aware.

## Lessons

1. **Investigate before fixing.** The initial instinct was to change FFmpeg flags and swap `break` for `continue` in the segment loop. Those changes would have masked symptoms but not solved the root cause — and worse, they would have introduced their own subtle issues.

2. **When the data contradicts every theory, question the environment.** The "impossible" observation — segments appearing in a folder after its handle was removed — made no sense in a single-process model. Instead of trying harder to explain it within the code, the right move was to check whether the single-process assumption itself was wrong.

3. **pm2 + process chains = orphan risk.** When pm2 manages a shell command that spawns child processes (`bash -> xvfb-run -> node`), `pm2 delete` only signals the direct child. Grandchild processes can survive as orphans. Always add explicit cleanup (`pkill`) in restart scripts when using process chains.

4. **Add structured debug logging with filters.** The `[SC-DEBUG]` tag + `SC_DEBUG=1` env var filter made the investigation possible. Without filtering, the log output from 30+ streamers being checked every second would have been unusable. The filter reduced hundreds of lines per second to just the relevant events.

5. **The interleaved pm2 process IDs in the log were the smoking gun.** `10|video-d` and `19|video-d` appearing simultaneously in the same log stream meant two processes were running under the same name. This would have been easy to miss without paying attention to the prefix numbers.
