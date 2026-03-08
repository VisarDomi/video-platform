# Svelte 5 Reactivity: Lessons Learned

Hard-won lessons from debugging reactive loops, phantom re-triggers, and state management anti-patterns in a Svelte 5 app.

## The golden rule

**An `$effect` must not write to state that it reads.**

If it does, it creates a dependency cycle: the effect runs, writes to state X, Svelte detects that X changed, and re-runs the effect. Even if the second run is a no-op, it's wasted work — and in the worst case, it's an infinite loop.

## The bug that took hours to find

### Symptoms

A live video would become "stuck" — swipe gestures were detected and processed correctly, navigation found the right target video, the store was updated, but the video on screen never changed. The app appeared completely frozen on that video.

### Root cause: reactive loop through store writes

The main `$effect` read `videoListStore.videos` (indirectly, via `preloadForVideo` → `filterByAliases`). Deep inside `preloadForVideo` → `loadStream`, when a preloaded video turned out to be a live HLS stream, it called `videoListStore.updateVideoLive()`. That method did:

```typescript
updateVideoLive(filename: string, isLive: boolean) {
    this.videos = this.videos.map(v =>
        v.filename === filename ? { ...v, isLive } : v
    );
}
```

This creates a **new array reference every time**, even when nothing actually changed (video was already marked as live). Since the effect depended on `videoListStore.videos`, the new array triggered a re-run, which called `preloadForVideo` again, which called `loadStream` again, which called `updateVideoLive` again — infinite loop.

### Why it only affected live videos

Non-live videos never hit the `updateVideoLive` code path. The early-exit path in `loadStream` only called store mutation methods when it detected a live stream (`el.duration === Infinity`). For regular videos, the early-exit resolved immediately with no store writes.

### The fix (three parts)

**1. Guard the store mutation:**
```typescript
updateVideoLive(filename: string, isLive: boolean) {
    const target = this.videos.find(v => v.filename === filename);
    if (!target || target.isLive === isLive) return; // bail if no change
    this.videos = this.videos.map(v =>
        v.filename === filename ? { ...v, isLive } : v
    );
}
```

**2. Separate the effects:**
Move `preloadForVideo` into its own `$effect`, isolated from the main video-change effect. This way, even if `videoListStore.videos` changes, it only re-triggers preloading — not the entire video switching logic.

**3. Scope store writes with `isActivePlayer`:**
`loadStream` was calling `playerStore.setCurrentVideoLive()` even when preloading adjacent videos. This mutated `playerStore.currentVideo`, which re-triggered effects that depended on it. Added an `isActivePlayer` parameter so store mutations only happen for the video the user is actually watching.

## Anti-pattern catalog

### 1. `$state` for non-reactive values

**Bad:**
```typescript
let currentFilename = $state<string | null>(null);
let wakeLock = $state<WakeLockSentinel | null>(null);
```

**Why it's bad:** These variables are never used in templates or as `$derived` inputs. `currentFilename` was only used inside an `$effect` as a "previous value" tracker — making it `$state` meant the effect depended on it AND wrote to it, causing a self-retrigger every time.

**Good:**
```typescript
let currentFilename: string | null = null;
let wakeLock: WakeLockSentinel | null = null;
```

**Rule:** Only use `$state` for values that drive UI rendering or are dependencies of `$derived`/`$effect`. If a variable is just bookkeeping (previous value tracking, caching, internal flags), use a plain `let`.

### 2. Reading and writing the same state in an `$effect`

**Bad:**
```typescript
$effect(() => {
    const cv = playerStore.currentVideo;
    const videoChanged = currentFilename !== cv.filename; // READS currentFilename
    currentFilename = cv.filename; // WRITES currentFilename → re-triggers
    if (videoChanged) { ... }
});
```

**Good:** Make `currentFilename` a plain `let` (not `$state`). Then the read/write doesn't create a reactive dependency.

**Rule:** If you need "previous value" tracking in an effect, use a plain variable, not `$state`.

### 3. Transitive store mutations from inside effects

**Bad:**
```typescript
$effect(() => {
    const videos = videoListStore.videos; // READS
    preloadForVideo(videos);              // transitively WRITES via updateVideoLive
});
```

**Why it's bad:** The dependency isn't obvious — the write is buried 3 function calls deep. The effect depends on `videos`, and `preloadForVideo` → `loadStream` → `updateVideoLive` creates a new `videos` array, re-triggering the effect.

**Good:** Either:
- Guard mutations to bail when value hasn't changed
- Use `untrack()` for values that are needed but shouldn't trigger re-runs
- Separate into independent effects

### 4. Store mutations that always create new references

**Bad:**
```typescript
updateVideoLive(filename: string, isLive: boolean) {
    this.videos = this.videos.map(v =>
        v.filename === filename ? { ...v, isLive } : v
    );
}
```

**Why it's bad:** `.map()` always returns a new array, even if nothing changed. Any `$effect` or `$derived` that reads `this.videos` will re-trigger.

**Good:**
```typescript
updateVideoLive(filename: string, isLive: boolean) {
    const target = this.videos.find(v => v.filename === filename);
    if (!target || target.isLive === isLive) return;
    this.videos = this.videos.map(v =>
        v.filename === filename ? { ...v, isLive } : v
    );
}
```

**Rule:** Every store mutation method should check if the value actually changed before creating new references.

### 5. One giant `$effect` that does too many things

**Bad:**
```typescript
$effect(() => {
    // reads 5 different reactive values
    // handles video switching
    // handles preloading
    // handles CSS classes
    // calls functions that mutate stores
});
```

**Why it's bad:** Any change to any dependency re-runs the entire block. A store mutation buried in preloading re-triggers video switching logic.

**Good:** Split into focused effects with minimal, clear dependencies:
```typescript
// Effect 1: video switching (depends on currentVideo, view, activePlayerIndex)
$effect(() => { ... });

// Effect 2: preloading (depends on video list, activePlayerIndex)
$effect(() => { ... });
```

## Using `untrack()` correctly

`untrack()` reads a reactive value without creating a dependency:

```typescript
import { untrack } from 'svelte';

$effect(() => {
    const activeIdx = playerStore.activePlayerIndex; // dependency: re-run when this changes
    const cv = untrack(() => playerStore.currentVideo); // NOT a dependency
    // ...
});
```

Use `untrack()` when you need the current value of something but don't want changes to it to re-trigger the effect.

**Caution:** Don't overuse `untrack()`. If you find yourself untracking most dependencies, the code is probably structured wrong. The effect should naturally depend on the things that should trigger it.

## Debugging reactive issues

### The difficulty

Svelte 5 reactive loops are hard to debug because:
- There are no stack traces pointing to "this effect caused this re-run"
- The loop happens at framework level, not in your code
- The symptoms are indirect (UI freezes, things stop working, performance drops)
- The write that causes the loop can be 3+ function calls deep from the effect

### Debugging approach that worked

1. **Add a pure-DOM debug overlay** — not reactive. Using `$state` for debug display creates its own reactive dependencies that can mask or worsen the problem. We used direct `document.createElement` and `appendChild`:
```typescript
let debugEl: HTMLDivElement;
function dbg(msg: string) {
    if (!debugEl) return;
    const d = document.createElement('div');
    d.textContent = msg;
    debugEl.appendChild(d);
}
```

2. **Log at the effect boundary** — put a log at the top of each `$effect` to see if/when it fires. If you see it spamming, you have a loop.

3. **Log what changed** — inside the effect, log the values of key dependencies and whether they've changed from the previous run.

4. **Trace the write** — once you know which effect is looping, trace every function call inside it to find which one mutates a reactive value that the effect depends on. Pay special attention to store method calls.

5. **Don't use `$state` for debug variables** — we learned this the hard way. A `$state` debug counter inside an `$effect` creates a dependency on itself, causing an infinite loop that didn't exist before adding the debug code.

### What NOT to do

- Don't add debug `$state` variables inside effects — they create new dependencies
- Don't use `$effect` to log reactive values — the logging effect itself becomes part of the problem
- Don't assume the bug is in the code you just wrote — the loop might be triggered by an existing effect that now has a new transitive dependency
