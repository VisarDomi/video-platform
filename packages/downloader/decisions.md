# Downloader Decisions

## Download loop must be boring (2026-03-21)

The download loop mirrors StreaMonitor's `hls.py`: fetch → download → if anything fails, stop. No in-loop recovery, no concurrent timers, no shared mutable state. Discovery handles retry with a fresh everything.

**Why:** The previous architecture had a concurrent quality monitor timer, in-loop URL re-resolution, and counter resets that masked persistent failures. CDN TLD flips (.org/.net/.com) triggered phantom quality changes that kept zombie downloads alive for hours — the 0o_NON_o0 incident ran for over an hour with only 16 real segments.

## No self-healing in the download path

Every error must be surfaced, never masked. No silent catches, no fallback-to-success on failure, no counter resets on non-download events. If something goes wrong, the download dies and the log says why.

**Why:** Three rounds of "fixes" added self-healing (re-resolve on 403, reset counters on quality change, return valid:true on read error). Each fix masked the symptoms of the previous fix's side effects. The root cause — a concurrent timer mutating shared state — was hidden for weeks because every surface symptom was individually "fixed."

## Room IDs are the source of truth for SC

The stable identifier is the numeric room ID, not the username. Usernames can be renamed. Room IDs are resolved once at add-time by the server, persisted in sc.txt, and never re-resolved during polling.

**Why:** Four accounts were 404-ing on every 5-second poll (16 warn lines/minute) because they were renamed/deleted. The old code resolved usernames to room IDs on every poll cycle — if the username was stale, it failed silently and the streamer was never monitored.

## Flat 20s cooldown, no exponential backoff

**Why:** Exponential backoff (30s→10min) meant a transient 403 at 3am could escalate to 10-minute waits, missing the stream entirely. StreaMonitor uses a flat 20s sleep. If the stream is gone, the bulk status check prevents downloads — the backoff doesn't need to gate retries.

## CDN TLD round-robin, not random

**Why:** Random pick from 3 TLDs has 33% chance of hitting the same one that just rejected us. Round-robin guarantees a different edge on each retry.

## Quality monitoring is inline, not concurrent

The quality check runs inside the download loop on the same thread. No timer, no shared mutable field, no races.

**Why:** The concurrent `StreamQualityMonitor` timer was the root cause of the zombie download bug. It wrote to `pendingUpgrade` which the download loop consumed — but TLD flips triggered phantom quality changes every 10 seconds, each resetting failure counters and the stale timeout.

## Segment failure stops the download

**Why:** The previous behavior (break inner loop, continue outer loop) meant a persistently failing segment was retried every second for 60 seconds. StreaMonitor stops immediately — if a segment can't be fetched, the session is probably dead.

## Fetch timeout on all HTTP calls (30s)

**Why:** Node's fetch has no default timeout. A CDN that accepts a TCP connection but never responds hangs the download forever — no heartbeats, no exit, no recovery. The absence of log output is impossible to notice at 3am.

## No cookie accumulation across API calls

**Why:** The old cookie jar merged Set-Cookie headers from all API calls for all 43 streamers. A bad Cloudflare cookie from one request poisoned every subsequent request. StreaMonitor's `_reset_session()` works by dropping all cookies; we achieve the same by never accumulating them.

## SC mouflon decryption returns null, not raw content

**Why:** The old code returned the encrypted playlist as-is when decryption failed. The download loop parsed it as HLS, found encrypted gibberish URIs, and tried to fetch them — producing generic "segment download failed" logs with no hint that decryption was the root cause.

## SC streamName uses `||` not `??`

**Why:** The API sometimes returns `streamName: ""`. Nullish coalescing doesn't catch empty strings.

## SC isCamAvailable/isCamActive gate before download

**Why:** A streamer can be `public` + `isOnline` in the bulk API but have `isCamAvailable: false` during transitional states. Downloading during this window wastes CDN requests that will fail.

## fMP4 duration from sidx boxes, not ffprobe

**Why:** SC fMP4 segments can't be ffprobed standalone — they have no container header.

## Tango 360x640 rejected

**Why:** Tango sometimes serves corrupt/unwatchable segments at this resolution.

## Disk space monitor stops the service at 50GB

**Why:** Prevents the disk from filling completely, which would corrupt in-progress recordings and potentially the OS. A marker file prevents restart loops.
