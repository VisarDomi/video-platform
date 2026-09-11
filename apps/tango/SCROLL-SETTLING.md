# Video position settling

Version 260 uses the position-based settling tested on the iPhone in Video
Platform. Both implementations use the same PositionSettlement sampler.

- Midpoint selection, three playing elements and 10,000px spacers are unchanged.
- There is no scrollend listener in the viewer. After finger release, sample
  scroll X/Y and visual viewport offsets, dimensions and scale until they remain
  stable for 100 ms. This is not a delay after scrollend.
- A change of at least 0.1 relative to the quiet-window anchor resets the window;
  smaller changes accumulate. A frame gap over 50 ms also resets it: a stalled
  main thread does not establish that native scrolling stopped.
- Only pending navigation is sampled. Held contact, pagehide and page hiding
  cancel it; release or return can start a fresh window. Sampling stops at rest.
  No per-frame element scan, database write or network request was added.
- Keep the existing layout correction after quietness: normalize the temporary
  recycling transform and return spacer landings to one adjacent video in the
  final scroll direction. Midpoint selection alone does not resolve blank space.

This remains a position/timing heuristic, not proof of Safari's final composited
frame. The iPhone comparison in Video Platform was accepted before porting it.
Stream Viewer still needs its own physical scrolling acceptance.

`npm run tests:extension` checks the production extension on Tango and XVideos
fixtures, including no-scrollend settlement, held touch, motion after release,
spacer landings, reversal, list bounds, playback modes and navigation state. Its
sampler checks frame stalls, viewport changes, cancellation and idle shutdown.
Browser fixtures do not simulate iOS momentum or real live HLS decoding.
