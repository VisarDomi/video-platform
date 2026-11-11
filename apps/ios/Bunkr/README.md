# Bunkr-only performance code

These source overrides and build settings are selected only for the `bunkr`
target. They hold its direct AV1/VP9 decoder, its player unit, cancellation,
retirement and the indexed local-library migration. The other five targets
cannot compile this directory or its decoder packages.

`VideoApp` retains the original shipped non-Bunkr engine (`b09884d`), including
its scroll/visibility, OK/Cut/Return and login/API fixes. Do not modify another
provider or shared HLS responses as a side effect of tuning Bunkr.

The common app registry and dispatchers select the target; they do not share
Bunkr's performance implementation. `test_provider_isolation.py` checks the
actual generated source lists and renewal inputs.

## Opening, moving on and seeking (November 11)

The library is 4K at 60 pictures a second with a keyframe every 4 to 7 seconds.
Three things made it slow, and each is handled in this directory or in the
decoder package only this target builds:

- **Keyframes, not exact pictures.** An exact landing decodes every picture from
  the keyframe before it: up to 420 4K pictures for one seek, for every touch
  sample of a drag, for a saved position and for each neighbour.
  - A saved position opens on the keyframe at or before it (`ViewerUnit.attach`,
    `InlineKeyframeLanding.start`).
  - A seek shows a keyframe on the finger's side of where the gesture began, so
    a drag never shows a picture from behind its start. AVPlayer does it with
    seek tolerances; the direct decoder with its keyframe index
    (`InlineKeyframeLanding`). There, a hardware decoder still lands exactly
    inside the group of pictures the gesture began in; a software decoder waits
    until the next keyframe is the nearer picture.
  - WebM/MKV load their keyframe index when they open (it is read from the
    file's tail, which the open already fetched); before, only the first seek
    read it and that seek was exact.
  - The video's clock and saved position are the keyframe's, so what plays after
    a seek is the picture that was shown.
- **A drag shows stills.** Playback holds while the finger is down. Each seek's
  keyframe is drawn before the next seek goes out (the direct decoder used to
  discard it), a touch sample that asks for the keyframe already showing is not
  sent, and lifting the finger continues from the still.
- **One player.** Only the video being watched holds a player. A paused
  neighbour shows a still of the keyframe it will open on (`NeighbourPoster`):
  read once from the original file without a player (the system's image
  generator for supported files, the direct decoder's keyframe extractor for the
  others), kept in `Library/Caches/BunkrPosters` (240 stills, least recently
  shown removed), one at a time, nearest the screen first, never while the
  watched video is starting. On a portrait screen up to six neighbours used to
  open a 4K decoder each at the moment of a tap or a swipe. The video last
  watched keeps its paused player for a quick return; an older one gives it up
  once it is off screen. A video that is closed leaves a still of where it
  stopped, so opening it again shows a picture at once.
- **Nothing heavy while the document moves.** Stopping the video left behind and
  opening the one that took the middle both wait until scrolling rests (or 0.6 s
  of a slow drag). The viewer has already muted the one left behind.
- The viewer is told the picture's size (the PC probed it) as soon as it has laid
  out, so it shows the still without waiting for the player.
- `playbackEvidence` no longer reads the player's access log while an item loads
  or seeks: that call waited for the item on the main thread (0.3 to 0.4 s per
  sample in the virtual iPhone).
- A seek's decoder flush is awaited off the main thread (decoder package): it waits
  for the pictures the decoder is in the middle of.

A floating-point round trip in the decoder package made a seek that named a
keyframe miss it by one bit; the packet cache then restarted from the keyframe
before and decoded a whole group of pictures before showing anything (seconds).
The landing now carries the keyframe's own value and the cache compares with
half a millisecond of slack.

### Measured on the virtual iPhone

`scripts/check-bunkr-fluidity.py` drives the real app (list, viewer, units)
against the PC's original files inside one guarded simulator session and
records what the player reports at every display frame. `Bunkr/FluidityChecks.swift`
(simulator builds only) is its side in the app. The simulator has no hardware
decoder and its FFmpeg/dav1d slices are built without assembly, so every 4K
picture is decoded in portable C on two cores: these are upper bounds for the
phone, and the playback rates are the simulator's, not the phone's.

| 4K file, virtual iPhone | Before | Now |
| --- | --- | --- |
| H.264: tap to picture / to playing | 2.1 s / 10.0 s | 1.1 to 1.2 s / 1.8 to 2.0 s |
| VP9, AV1 (MP4, MKV, WebM): tap to picture / to playing | the simulator fell back to VLC | 0.6 to 0.9 s / 1.1 to 1.5 s |
| Opening a video again: picture | as a first opening | its still in 10 ms, the player's in 0.7 to 0.9 s |
| Drag (0.75 s): pictures while the finger moves | none | 1 to 6 |
| Drag: finger lifts to playing | 3.1 s | 0.8 to 1.8 s |
| Jump on the progress bar: to picture / to playing | 11 to 12 s / 12 to 13 s | 0.04 to 0.65 s / 0.7 to 1.5 s |
| Swipe to the next video: picture | at once (every neighbour held a 4K player) | at once (a still, under 40 ms) |
| Swipe: to playing | 1.2 s | 1.0 to 1.5 s |
| Longest main-thread gap during a seek | not measured | 55 ms (434 ms before the decoder's flush left the main thread) |
| Main-thread gaps over 50 ms while playing | not separated from the measuring itself | none |
| Pictures a second, VP9 4K30 | 4 (VLC) | 20 to 24 |
| Pictures a second, AV1 4K60 | 20 with six neighbours open | 35 to 38 |

The 1080p H.264 file, which the simulator decodes easily, shows what the same code
does when decoding is not the limit: 23 pictures during the same drag, playing 10 ms
after the finger lifts, a jump playing after 0.18 s. Evidence (raw samples, engine
logs, screenshots) is on the PC under `~/.cache/bunkr-fluidity-20261111/`.

Run it from the QA checkout on the Mac (never the delivery mirror), after a
simulator build (`SIMULATOR=1 python3 scripts/build-provider.py bunkr`):

```sh
mac-workload simulator --visible --app video-platform --device UUID --timeout 600 -- \
  python3 scripts/check-bunkr-fluidity.py --device UUID \
  --app build/bunkr/native/Release-iphonesimulator/BunkrLocal.app \
  --out /private/evidence/directory --videos h264,vp9,av1 --reopen
```

`--videos` takes codecs or filename prefixes; `--cleanup` removes the simulator
copy at the end of a testing session. The lifecycle check
(`scripts/check-inline-simulator.py`, [ThirdParty/AetherCore](../ThirdParty/AetherCore/README.md))
covers the still without a decoder, the keyframe drag, background and
foreground, the saved position, the end of a file, replay and the fallback.

### Limits that remain

- The phone was not operated or read: its numbers are the owner's to judge.
- AV1 has no hardware decoder on the A14. dav1d decodes it on the processor, so
  4K60 AV1 costs far more than H.264 or VP9 there, whatever the player.
- After a seek, playback starts once the decoder has queued its first pictures;
  in the simulator that wait is 0.5 to 0.8 s of software decoding.
- A seek lands up to one group of pictures (4 to 7 s) before its target.
- Each range request opens a new TLS connection (the PC serves HTTP/1.1).
