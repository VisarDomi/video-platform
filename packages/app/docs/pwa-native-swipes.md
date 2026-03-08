# Implementing Native-Feel Swipe Gestures in a PWA

How we built a full touch gesture system that makes a SvelteKit PWA feel like a native iOS video player app.

## The challenge

PWAs on iOS have a fundamental problem: the browser owns touch gestures. Swipe-from-edge navigates browser history, pinch zooms the page, pull-down refreshes. To build a video player with custom swipe navigation, seek-by-drag, and edge-back, we need to take full control of touch input.

## The key CSS: `touch-action: none`

The single most important line:

```css
.video-view {
    touch-action: none;
}
```

This tells the browser: "don't interpret any touch gestures on this element." No scroll, no zoom, no navigation. We handle everything in JavaScript.

We tried `touch-action: pinch-zoom` to let the browser handle zoom natively while we handled swipes. It didn't work — the browser's pinch-zoom gesture recognition conflicted with our single-finger handlers, causing intermittent lockouts where no gestures worked. The only reliable approach is `touch-action: none` with everything in JS.

## Gesture architecture

### State machine

Every touch goes through a classification pipeline:

```
touchstart → record origin point
touchmove  → once 10px threshold crossed, classify gesture → execute
touchend   → finalize gesture
```

Two state variables drive classification:

```typescript
let swipeAxis: 'none' | 'horizontal' | 'vertical' = 'none';
let swipeType: 'none' | 'edge-back' | 'seek' | 'nav' | 'ui' = 'none';
```

Once classified, a gesture is locked in for the entire touch sequence. This prevents accidental mode switches mid-gesture.

### Classification rules

On the first `touchmove` that exceeds the 10px dead zone:

```
if (horizontal):
    if (started at left edge, moving right) → edge-back
    if (top half of screen, non-live video) → seek
    else                                    → ui (show/hide controls)
if (vertical)            → nav (change videos)
```

### Gesture implementations

**Edge-back** (swipe from left edge to go back to list):
- Tracks `swipeProgress` (0 to 1) as the finger moves
- The entire video view translates right via `transform: translateX()`
- On release: if progress > 30%, animate to 100% and navigate back; otherwise snap back to 0
- Uses a 250ms CSS transition during the snap animation
- A `swipeAnimating` flag blocks all touch handlers during the transition to prevent conflicts

**Navigation** (vertical swipe to change videos):
- Only fires on touch end, not during the swipe (no visual feedback during drag)
- Requires a minimum flick threshold of 80px
- Swipe up = next video, swipe down = previous video
- Uses a 3-player carousel: active player + preloaded next + preloaded previous

**Seek** (horizontal swipe on top half to scrub timeline):
- Records `seekBaseTime` at the start of the gesture
- Maps horizontal displacement to time: `seekDelta = (dx / screenWidth) * 60` (60 seconds per full-width swipe)
- Updates `currentTime` in real-time during the drag
- Disabled for live videos (infinite duration)

**UI toggle** (horizontal swipe on bottom half to show/hide controls):
- Triggers on swipe end
- 80px threshold to trigger

### Critical guards

1. **`touchcancel` handler**: The browser fires `touchcancel` when it takes over a gesture (notification shade, system gesture). Without handling it, `swipeType` state gets stuck permanently. The handler resets all gesture state.

2. **Animation lock**: `swipeAnimating` prevents all touch handlers from firing during the 250ms edge-back transition. Without this, a touch during the animation could start a new gesture while the view is mid-slide.

## The 3-player carousel

To achieve instant video switching (like native TikTok/Instagram), we pre-render adjacent videos:

```
Player 0: current video (active, visible)
Player 1: next video (preloaded, hidden, playing muted)
Player 2: previous video (preloaded, hidden, paused)
```

On swipe-to-next:
- `activePlayerIndex` rotates: `(current + direction + 3) % 3`
- The preloaded player becomes active (already has video frames ready)
- The old active player becomes background
- New adjacent videos are preloaded onto the freed-up player

This makes navigation feel instant because there's no loading delay — the video is already buffered and decoded.

### Visibility via CSS classes + inline opacity

```css
.active-player  { z-index: 5; opacity: 1; }
.background-player { z-index: 1; opacity: 0; }
```

When loading a new video, the active player starts with inline `opacity: 0` (overrides CSS), loads the stream, then sets inline `opacity: 1` once ready. This prevents showing a black frame or stale content.

## Preventing `e.preventDefault()` conflicts

`e.preventDefault()` is called in `touchmove` to prevent any residual browser gesture handling. This is safe because `touch-action: none` already declares our intent, and `preventDefault()` provides defense-in-depth.

We do NOT call `preventDefault()` in `touchstart` — doing so would prevent focus events and could interfere with video element interaction.

## Live video considerations

Live HLS streams have `duration === Infinity`. This requires special handling:

- Seek gesture is disabled for live videos (can't scrub a live stream)
- Horizontal swipes on live videos in the top half classify as `ui` instead of `seek`
- Progress saving is skipped (no meaningful position to save)

## PWA manifest considerations

The app uses `"display": "standalone"` in the manifest to hide the browser chrome. This is essential — with browser chrome visible, the browser's own swipe-back gesture on the left edge competes with our edge-back implementation.
