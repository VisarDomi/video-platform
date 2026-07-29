# Video Platform App

Pure TypeScript frontend for video editing across multiple streaming providers
(`tango`, `fc2`, `sc`). The current implementation is in `src`; the previous
Svelte implementation remains available in Git history as migration reference.

## Read on demand

- Overflow rule:
  `~/Documents/memory/overflow.md`

## Rules

- Verify frontend changes against the running app, not only static code.
- Preserve native Safari list/viewer navigation, bfcache restoration, and edge-back
  ownership.
- The viewer is a native scrolling 10k/natural/10k three-scope document.
  Videos use intrinsic `width: 100%; height: auto` geometry without clipping.
- Player units own video, timeline, and media lifecycle. One fixed overlay,
  inset from Safari's top and bottom boundaries, latches to the settled scope.
