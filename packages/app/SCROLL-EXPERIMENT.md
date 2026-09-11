# Position-based video settlement — 2026-09-11

Initially tested in Video Platform only. After the user accepted the iPhone
behavior, the same sampler was ported to Stream Viewer 260.

The three playing elements, live midpoint selection, temporary layout transform,
10,000px spacers and one-adjacent-video spacer landing behavior are unchanged.
Layout normalization still needs to run: midpoint selection cannot rebase a
recycled document or bring a blank-spacer landing back onto a video by itself.

The viewer no longer listens to scrollend. After release, PositionSettlement
samples scroll X/Y and visual viewport offset/size/scale in animation frames.
100 ms of stable samples permits the existing correction. This is a quietness
window, not an additional delay after scrollend. Movement of at least 0.1 CSS px
relative to the quiet-window anchor restarts it; subpixel changes accumulate.
A frame gap over 50 ms also restarts it rather than treating a main-thread stall
as evidence that native momentum stopped.

Only a pending navigation is watched. Held contact, pagehide and hiding the page
cancel sampling. Return/release starts a fresh window. No idle animation loop,
per-frame DOM element scans, storage writes or network calls were added. Existing
midpoint selection still reads the three video rectangles on scroll.

This remains a Safari experiment: JS viewport positions are not guaranteed to
describe the compositor's exact last visible frame. The constants are explicit
heuristics, not a universal browser contract. A device that cannot provide timely
frames can defer correction until it does; do not silently add a timeout that
forces a correction during potentially active momentum.

Validation:

- `npm run check -w app`
- `node packages/app/test/position-settlement.mjs`
- `npm run build:frontend`
- `node packages/app/test/viewer.mjs`

The fixture browser checks the built app without real server mutations: selection
continuity, no corrective scroll during motion/held contact, settlement without
scrollend, early-event immunity, spacer direction/reversal/list boundaries, normal
history navigation and playback controls. The sampler checks stalled frames,
viewport changes, cancellation and idle shutdown. These are not iOS physics tests.

Phone acceptance: reload the web viewer, compare slow drag and long flick, hold a
finger still, reverse direction, land in the empty spacer, and test first/last
entries plus Safari Back and background return. Confirm no abrupt momentum cut,
no blank resting view, only one adjacent video selected from a spacer, and controls
become usable after landing. The initial iPhone comparison was accepted on
September 11; keep these checks for future changes to either viewer.

Only the web frontend is rebuilt for this experiment. The separate native app
and video pipeline are not rebuilt, restarted or installed by this change.
