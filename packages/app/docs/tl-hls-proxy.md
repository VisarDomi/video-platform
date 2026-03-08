# TL Live Stream HLS Proxy: From Download-First to Sub-Second Playback

How we reduced time-to-first-frame for Tango Live streams from 3-5+ seconds to under 1 second, and the bugs we hit along the way.

## The problem

The original flow was download-first:

```
click -> backend resolves master playlist -> downloader fetches segments to /tmp/
      -> backend serves from disk -> hls.js plays
```

Every click waited for the downloader to resolve the master playlist, fetch the live playlist, download at least one segment, write it to disk, and serve it via the HLS route. That's 3-5+ seconds before the first frame. The old tango-explorer userscript played directly from CDN in ~500ms by pointing hls.js at the CDN URL.

Direct CDN access from the browser fails: no `Access-Control-Allow-Origin` header (CORS), and playlist fetches require auth cookies (`tt`, `ttu`, `tte`). Segment URLs have tokens baked in and don't need auth, but still fail CORS.

## The solution: backend HLS proxy

The backend becomes a transparent proxy between hls.js and the CDN. No disk I/O, no waiting for the downloader. The downloader still runs in parallel for archival.

```
hls.js -> GET /api/tl/proxy/{alias}/live.m3u8 -> backend fetches CDN (with auth) -> rewrites URLs -> returns
hls.js -> GET /api/tl/proxy/{alias}/seg.ts    -> backend fetches CDN (no auth)   -> pipes bytes   -> returns
```

### Architecture

**4 endpoints** in `tl-proxy.routes.ts`:

1. `POST /tl/proxy/start` — takes `masterPlaylistUrl` + `alias`, resolves master -> 720p variant -> live playlist URL. Stores a session in memory. Returns the proxy playlist URL. Returns immediately if session already exists. This is the key latency win: no segment downloads, just one HTTP round-trip to resolve the playlist chain.

2. `GET /tl/proxy/:alias/live.m3u8` — fetches the live playlist from CDN with auth cookies, rewrites segment lines from CDN URLs to local filenames (e.g., `seg_12345.ts`), stores the CDN->local mapping in a `segmentMap`. No-cache headers so hls.js always gets the latest playlist.

3. `GET /tl/proxy/:alias/:segmentFile` — looks up the CDN URL from `segmentMap`, fetches the segment (no auth needed, tokens are in the URL), pipes the response body directly to the client via `Readable.fromWeb()`. No buffering to disk.

4. `POST /tl/proxy/stop` — tears down the session.

**Cleanup**: 30s interval removes sessions idle for >120s (safety net if the frontend doesn't call stop).

## Bugs encountered

### Bug 1: Cross-provider state pollution (TL streamers appearing in tango list)

**Symptoms**: Switch from TL to tango provider, some TL streamers appear in the tango video list. Happens more with rapid switching.

**Root cause**: `videoListStore.initialize()` only set `selectedProvider` and `isLoading` — it never cleared `videos` or other TL-specific state. Async TL operations that were in-flight when the user switched providers would complete and inject TL data into what was now the tango video list.

**Why the first fix didn't work**: We added `if (selectedProvider !== 'tl') return` guards after every `await`. But this is racy — the guard checks the provider at one instant, and the mutation happens at the next. In JavaScript's microtask model, a stale `.then()` callback queued before the Svelte effect fires can run before `initialize()` clears state.

The fundamental issue: **`$effect` cleanup runs as a microtask, so already-queued `.then()` callbacks from the previous effect run can execute before the cleanup**. This means you can't rely on effects alone to cancel async work.

**The fix (three layers)**:

1. **Epoch counter** — `videoListStore.epoch`, a plain number (not `$state` — no reactive overhead). Bumped in both `setProvider()` (synchronous, from the swipe handler) and `initialize()` (from the effect). Every async function captures the epoch before its first `await` and bails if it changed:

```typescript
async function loadTlStreams(epoch: number) {
    const data = await fetchStreams();
    if (videoListStore.epoch !== epoch) return; // stale
    videoListStore.setVideos(videos);
}
```

The key insight: `setProvider()` is called synchronously from the swipe handler, before any microtasks drain. So bumping epoch there closes the window that the effect-only approach left open.

2. **Store-level guards** — mutation methods check the selected provider before proceeding. Belt-and-suspenders: even if an epoch check is missed, the store itself rejects stale mutations.

3. **Clear all state in `initialize()`** — reset `videos` and all provider-specific state to empty defaults.

### Bug 2: `preventDefault()` ignored on touchmove (Firefox warning)

**Symptoms**: `Ignoring 'preventDefault()' call on event of type 'touchmove' from a listener registered as 'passive'`

**Root cause**: Svelte 5 registers declarative event handlers (`ontouchmove={handler}`) as passive by default for touch/wheel events. Passive listeners cannot call `preventDefault()`.

**The fix**: Remove `ontouchmove` from the template, attach it imperatively via `$effect` with `{ passive: false }`:

```typescript
$effect(() => {
    if (!videoViewEl) return;
    const el = videoViewEl;
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', handleTouchMove);
});
```

## What could have been done better on debugging

### The back-and-forth problem

We debugged the proxy integration through a slow cycle: make a change, build, deploy, test on device, read logs, send logs back, analyze, repeat. Each round-trip took 2-5 minutes. For the state pollution bug alone, this took three iterations (selectedProvider check, epoch-in-initialize, epoch-in-setProvider + store guards).

### What we should have done

1. **Add structured debug logging from the start.** Before deploying the first version, add `console.log` at every decision point in the critical path. Label them with a prefix like `[stream]` so they're easy to filter. Remove them after the feature stabilizes.

2. **Think about the async timing on paper first.** The state pollution bug was fundamentally about microtask ordering. Drawing a timeline of "user swipes -> setProvider -> goto -> effect schedules -> microtask queue drains -> effect runs" would have revealed the race window immediately, instead of trying three different fixes.

3. **Test provider switching early.** The state pollution was a pre-existing issue that the proxy work exposed. Testing the TL <-> tango switch before starting proxy work would have caught it sooner.

4. **Use the epoch pattern from the start for any async-from-effect code.** The codebase already had `navCounter` for exactly this purpose in `navigateToVideo`. The same pattern should have been applied to all async operations launched from effects. The general rule: if an `$effect` launches async work, it needs a generation counter to invalidate stale completions, and the counter must be bumped synchronously at the user action, not inside the effect.

### The general debugging playbook for async + reactive issues

1. **Identify the mutation**: What store method is being called with wrong data? Add a temporary guard that logs and returns: `if (this.selectedProvider !== expectedProvider) { console.warn('STALE', ...); return; }`
2. **Trace the caller**: Where does the mutation originate? Is it from an async callback? Which `await` did it cross?
3. **Map the timeline**: Draw out the sequence of synchronous code, microtask scheduling, and microtask execution. Identify windows where stale callbacks can run.
4. **Fix at multiple layers**: Don't rely on a single check. Guard at the callsite (epoch), guard at the store (provider check), and clear state eagerly (initialize).
