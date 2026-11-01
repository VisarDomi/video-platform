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
MP4s, or when AVFoundation fails to produce a Bunkr picture. Supported files keep
AVFoundation. This changes decoding on the phone; the PC serves original bytes.
A permanent child surface stays under the same fitted/zoomed shared player view.
Neighbours prepare with VLC's native `start-paused` option and remain paused. The player shares one
libvlc instance, initializes media off the main thread, and uses the same native
mute/seek/progress/background policy as the rest of the viewer.

The official iOS binary uses Apple's Secure Transport with the system trust
store, including the PC CA already trusted by the phone's existing local apps.
Certificate and hostname verification remain enabled. No TLS bypass is used.

Do not play video in this Mac's simulator. Its UI checks use static real-view
fixtures. `Tests/OriginalVideoProbe.swift` is a separate, temporary native app for
physical-device-only codec tests; `DECODER_PROBE=1 scripts/project.py bunkr`
generates it only in the QA mirror. It uses its own bundle/container and writes
only its own diagnostic report. It is never shipped in a product app.

The owner selected the previously playing VLCKit 4 build on November 1.
Initial original-file playback is verified on the A14 and confirmed by the owner.
Precise seeking and end/return behavior still need the deferred Bunkr polish pass.
The production 3.7.3 experiment was not shipped.
