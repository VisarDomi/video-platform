# Video Platform App

Pure TypeScript frontend for video editing across multiple streaming providers
(`tango`, `fc2`, `sc`). The current implementation is in `src`; the previous
Svelte implementation is retained in `src_old` as migration reference only.

## Read on demand

- Overflow rule:
  `~/Documents/memory/overflow.md`

## Rules

- Verify frontend changes against the running app, not only static code.
- Preserve native Safari list/viewer navigation, bfcache restoration, and edge-back
  ownership.
- A player unit owns its video, overlay, timeline, and media lifecycle as one
  indivisible item.
