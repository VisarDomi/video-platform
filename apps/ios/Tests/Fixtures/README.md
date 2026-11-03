# Inline decoder fixture

`inline-vp9-opus.webm`: synthetic test pattern and 440 Hz tone, 1280×720 at
30 fps, 20.008 seconds, VP9 + mono Opus. No recording is used. The generated
test media is dedicated to CC0.

SHA-256: `d8d798cd9049d2d5c4eb7a94edce87819113997aab80bf521a00a3b369e5f3f4`.

Generated on the PC with:

```sh
ffmpeg -nostdin -filter_threads 2 \
  -f lavfi -i 'testsrc2=size=1280x720:rate=30' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 20 \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -row-mt 1 -threads 2 \
  -crf 40 -b:v 0 -g 60 -c:a libopus -b:a 48k inline-vp9-opus.webm
```

The checked-in bytes are authoritative; encoder versions can produce different
bytes with the same command. This fixture belongs only to simulator checks.
