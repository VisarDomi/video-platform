# Direct original-file playback

Bunkr's alternate decoder is a provider-independent `ViewerDecoder` adapter. It
keeps the shared `ViewerUnit`, fitted surface, gestures, timeline, volume,
background audio and restoration. The PC serves original bytes; there is no
video transcode, replacement video or client loopback remux.

`FFmpegVideoDecoder` uses the pinned AetherEngine direct sample-buffer backend:
FFmpeg demuxes the source, VideoToolbox handles hardware-supported formats, and
libavcodec/dav1d handles unsupported formats. The option named `.software`
selects that direct host, which can still use `HardwareVideoDecoder`; it does
not force software video decoding. A successful hardware session requires
`kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder`.
VP9 registers Apple's supplemental decoder when the OS exposes that API. AV1
uses software on hardware without an AV1 decoder. Supported original files keep
AVFoundation; The first rollout candidate selects this backend only after a real VP9 hardware session opens; AV1 and other fallback formats retain VLC until their separate checks pass. VLC also remains the preparation fallback during the migration.

Dependencies:

- AetherEngine 7.54.0, revision `e1cd3d46830a04d72dbc5d61e930736bf3a1183d`:
  <https://github.com/superuser404notfound/AetherEngine>. Vendored core sources,
  LGPL3 with upstream App Store/DRM exception. Optional SMB/TrueHD modules are not
  included. Local hook `AetherEngine+InlineVideo.swift` exposes host-owned video
  suspension, actual decoder selection and render metrics. `InlineDecoderRetirement.swift` moves the decoder/reader close off the main thread; the host stops new work and silences the old output immediately, rejects late frames, awaits the unique renderer removal, and flushes/closes the retained output, C decoders and reader on its serial retirement worker.
  The inline host disables `automaticallyRewindsBeforePlay`: upstream otherwise
  rewinds a play request within half a second of the end. `ViewerUnit` owns
  explicit replay. Queued audio reaches its playout clock before EOF is published,
  including when the user pauses the queued tail. Playing foreground returns
  use video-only recovery: the same renderer retains its picture and audio keeps
  its clock. Paused inputs may seek to recover their still. The native check reads
  the synchronizer directly to verify return continuity.
- FFmpegBuild 3.12.1, revision `9c87af0231fd1403654c14a0e867fe8aa43c5bea`:
  <https://github.com/superuser404notfound/FFmpegBuild>. FFmpeg8.1.3 + dav1d1.5.4;
  see its `BUILD-INFO.txt`, build script and license records for exact patches,
  source revisions and configuration.
- LibDovi 2.1.0, revision `0d7cce1d6836a30d13a3a2326e50a153af53f014`:
  <https://github.com/superuser404notfound/LibDovi>.

`prepare-ffmpeg.py` verifies pinned tar archive hashes and selects iOS device and
arm64/x86_64 simulator slices. Binaries and their hash receipt are build inputs,
not Git files. The queue captures these inputs for each update and monthly
renewal. The C frameworks were built with a newer SDK; the existing Xcode26.3
compile and native execution checks remain required, independently of the SDK
number in their build record.

**Link Aether's frameworks before VLCKit.** Both export FFmpeg C symbols. Mixed
bindings can pass a version-only check while the struct-consuming functions bind
to an incompatible copy. `verify-ffmpeg.py` inspects all public FFmpeg imports and
rejects VLC bindings before deployment, then checks the embedded frameworks.

Native validation uses the isolated OriginalVideoProbe on the Mac's virtual
iPhone under the shared guard, one decoded stream at a time. The owner alone
judges physical-iPhone fluidity; never operate or read that phone for this task.

For the short lifecycle check, build in the QA checkout through `mac-workload
build` with `SIMULATOR=1 DECODER_PROBE=1 INLINE_CODEC_QUICK=1 python3
scripts/build-provider.py bunkr`. The source generator refuses the quick probe
without the simulator setting. Then run, inside the exact owned guest's guarded
session:

```sh
python3 scripts/check-inline-simulator.py --device UUID \
  --app build/bunkr/native/Release-iphonesimulator/OriginalVideoProbe.app \
  --out /private/evidence/directory
```

Before booting that guest, verify the completed artifact with
`python3 scripts/check-inline-simulator.py --app /path/to/OriginalVideoProbe.app
--validate-build`. The explicit quick-probe marker distinguishes it from the
older codec diagnostic that shares its stable bundle ID.

The checksum-pinned synthetic VP9/Opus fixture is checked in under
`Tests/Fixtures`; `--prepare-fixture` stages it without network access. Its twenty
seconds leave time for a genuine app switch on the slower Mac. See the adjacent
fixture README for its generation command.
This check deliberately permits software fallback on the simulator, where the
hardware capability differs from the Mac host. It covers paused preparation and
seek, actual app background/foreground with the audio clock advancing, a returned
video frame, saved restoration, stopped EOF, explicit replay and UI teardown.
Every run stops the diagnostic process. At the end of the testing session, use
`--device UUID --cleanup` inside the same guarded guest to remove the diagnostic
app; never uninstall/reinstall it between attempts just to reset permissions.

The check also plays and pauses the existing VLC fallback with both decoder
libraries linked. Its app-switch fixture opens Settings and returns through
normal app activation; a custom return URL would add an iOS confirmation dialog.

The VLC fallback prepares a paused first picture with its native frame-step API
after the absolute initial seek; the step callback confirms the image without
starting playback. Normal play, pause and explicit seek retain the shared unit's
intent.
