# Original-file video decoding

This is a local SwiftPM wrapper around VideoLAN's official VLCKit binary:

- Upstream: https://github.com/videolan/vlckit
- Official package revision: `2e0868f5ed40fe59cd92f377645fdcc260c6e759`
- Archive: `VLCKit-4.0-20260929-1631.zip`
- Binary URL and SHA256: `scripts/prepare-vlckit.py`
- License: LGPL 2.1 or later; see `LICENSE.txt` and upstream source.

Run `python3 scripts/prepare-vlckit.py` from `apps/ios` before syncing Bunkr.
It verifies the official archive checksum and stages only the unchanged device
and simulator framework slices, retaining arm64 and x86_64 simulator support.
The wrapper's outer Info.plist lists those selected iOS slices; framework code
is not rebuilt or patched. Generated binaries and the verification receipt stay
outside Git. Deployment copies them with the sources, and Bunkr's renewal inputs
include the staged framework, receipt, wrapper and preparation script.

Only Bunkr links VLCKit. The common viewer selects it for original AV1/VP9/VP8
files, MKV/WebM/AVI/TS containers, or when AVFoundation fails to produce a Bunkr picture. Supported files keep
AVFoundation. This changes decoding on the phone; the PC serves original bytes.
A permanent child surface stays under the same fitted/zoomed shared player view.
Neighbours prepare with VLC's native `start-paused` option and remain paused. The player shares one
libvlc instance, initializes media off the main thread, and uses the same native
mute/seek/progress/background policy as the rest of the viewer.

Use the bundled `avformat` MP4 parser for this fallback. The native MP4 parser in
the pinned libvlc build repeatedly resets dav1d during paused AV1 preroll and can
jump far beyond the requested position. This changes only the phone's container
parser; the server and original bytes remain unchanged.

Saved positions seek on the full input after it opens. Do not set `start-time`:
libvlc then exposes a zero-based range for the remaining movie. Native seek
completions are serialized, paused intent holds its clock, and the first restored
picture stays hidden until a frame from the requested position is displayed.
`VideoTerminalState` distinguishes a sampled terminal clock from failed input;
normal EOF remains stopped through resume, and an explicit seek reopens it.

The official iOS binary uses Apple's Secure Transport with the system trust
store, including the PC CA already trusted by the phone's existing local apps.
Certificate and hostname verification remain enabled. No TLS bypass is used.

Do not play video in this Mac's simulator. Its UI checks use static real-view
fixtures. `Tests/OriginalVideoProbe.swift` is a separate native diagnostic app for
physical-device-only codec tests; `DECODER_PROBE=1 scripts/project.py bunkr`
generates it only in the QA mirror. It uses its own stable bundle/container and writes
only its own diagnostic report. Update it in place between runs in the same testing
session, preserving Local Network permission, and stop its process after each run.
When the task is complete, uninstall the diagnostic app and verify cleanup. It is
never shipped in a product app.

After a guarded probe build, run `scripts/check-original-video.py --app <probe.app>
--device <UDID> --original-url <original HTTPS URL> --out <private report directory>`
on the Mac. It waits for the one-time LAN approval, validates a fresh run ID and
the actual native clock, and stops only its own PID. The full real-ViewerUnit
check covers paused preparation, paused seek to 120 s, video-off audio/time,
track return, saved 130 s restore, terminal EOF without recovery, and explicit
replay. These checks passed on the A14 using the original AV1 file on November 1.

The probe also accepts `--original-file <original>` with `--filename`, `--codec`
and `--duration` for a device-local check of another original container. It copies
bytes without conversion and needs no phone Local Network approval. It checks
main-thread teardown duration, subsequent event-loop stalls and retired-player cleanup as
well as the shared playback timeline. Use the simulator-only
`scripts/check-navigation.py` for the real list/back/forward/relaunch path, with
static player surfaces and no video decoding.

Finish the task with `scripts/check-original-video.py --cleanup --device <UDID>
--out <private report directory>`. This removes only the isolated diagnostic app,
verifies that its process and installation are absent, and checks that other
installed apps are unchanged.
