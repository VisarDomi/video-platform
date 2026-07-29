# Safari Native HLS Timeline Investigation

Last updated: 2026-07-29

This is a living investigation document. Edit it when new phone evidence
strengthens, weakens, or disproves a claim. Do not preserve an attractive theory
after the evidence contradicts it.

The immediate question is:

> How does Safari construct the media timeline for native HLS, and which
> information is missing from our `playlist.m3u8` and ffprobe-based repair model?

The practical consequence is larger than the displayed duration. Editing is
WYSIWYG: a time selected in Safari must resolve to the segment containing the
visible frame. A model that merely makes the endpoint match can still select the
wrong segment in the middle.

## Confidence labels

- **Confirmed:** reproduced on the iPhone with a controlled comparison.
- **Strong evidence:** repeated observation with a remaining experimental
  ambiguity.
- **Provisional:** plausible interpretation that needs a discriminating test.
- **Rejected:** contradicted by an existing fixture.

## Confirmed facts

### Safari exposes more than one notion of duration

On the tested native-HLS media elements:

- `seekable.end()` generally follows the sum of playlist `#EXTINF`.
- `duration` initially generally follows that same playlist duration.
- At the physical end of playback, `currentTime` and `duration` can become a
  different value.
- Consequently, `currentTime`, `duration`, and `seekable.end()` need not agree
  at `ended`.

For `master-hawk`, for example, the playlist and `seekable.end()` remain about
`1702.429s`, while different Safari media-session histories have ended around
`1702.530s`, `1703.547s`, `1704.595s`, `1707.043s`, and `1707.292s`.

The UI must therefore describe exactly which clock it is displaying. Calling
one of these values simply “Safari duration” hides important behavior.

### Safari's final mapping can depend on media-session history

This is confirmed on both `master-hawk` and `cutemonkey`. The first
`cutemonkey` experiment had a progress-restoration ambiguity; a second matrix
established every initial position on the provider list before the viewer/media
element existed and reproduced a larger set of deterministic mappings.

For `master-hawk`:

- A fresh reload followed by an immediate seek near the tail repeatedly ended
  around `1702.530s`.
- Playing approximately one second from the beginning before seeking to the
  tail retained that mapping.
- Playing approximately three seconds or more from the beginning before the
  same tail seek repeatedly ended around `1703.547s`.
- Reloading reset the mapping.
- Re-seeking inside the same initialized media element did not reset it.

Controlled evidence from `cutemonkey-81756`:

| Initial viewer position and construction | Ended time | Over playlist |
|---|---:|---:|
| Tail at `596.881s`, no earlier playback | `602.892772s` | `+0.011772s` |
| Start at `0s`, play about 3s | `611.253406s` | `+8.372406s` |
| Start at `4s`, play about 5s | `611.253406s` | `+8.372406s` |
| Start at `8s`, play about 3s | `613.523698s` | `+10.642698s` |
| Start at `86s`, play across first discontinuity | `612.501700s` | `+9.620700s` |
| Start at `91s`, after the first short epochs | `610.304630s` | `+7.423630s` |

Every case then sought to the same playlist position, `596.881s`, and played to
`ended`. `seekable.end()` remained `602.881s` in every case. The playlist and
media bytes were unchanged.

This proves that Safari constructs different durable media-time mappings from
different initial regions. It also proves that the mapping is not simply
“beginning versus tail”: starts at 0, 8, 86, and 91 seconds all produced
different endpoints.

The initial positions were controlled before viewer construction:

1. Navigate to `/videos/tango`.
2. Write the desired `video-progress-{filename}` value on the list document.
3. Navigate normally to the viewer.
4. Verify the first observed `currentTime`.

The observed initial positions were approximately `0.318`, `4.220`, `8.239`,
`86.230`, `91.003`, and `596.883` seconds respectively.

### Playback progress changes the mapping even when `buffered` looks equivalent

A controlled refinement started `cutemonkey` at zero, allowed a short amount of
construction playback, then sought to the common tail:

| Requested construction playback | Time reached | Buffered after construction | Final overrun |
|---:|---:|---|---:|
| none | `0.304s` | `1.003–27.939s` | `+1.001s` |
| `250ms` | `0.796s` | `1.003–72.948s` | `+0.999s` |
| `750ms` | `1.288s` | `1.003–72.948s` | `+5.404s` |
| `1250ms` | `1.795s` | `1.003–70.948s` | `+6.850s` |
| `2000ms` | `2.585s` | `8.434–179.912s` | `+8.372s` |

The middle cases were repeated:

- `750ms` repetitions ended at `+5.403s` and `+5.405s`.
- `1250ms` repetitions ended at `+6.849s` and `+6.853s`.

The states are reproducible rather than random timing noise. Most importantly,
the `250ms` and `750ms` cases exposed the same buffered interval but ended about
4.4 seconds apart. Which media Safari reports as buffered is therefore
insufficient to predict the constructed time mapping. Playback/decode progress
is an independent input.

### Initial anchoring and later decode progress are separate inputs

Tests around the nearly-empty-video `8.ts` used controlled list-to-viewer
positions:

| Initial region | Construction playback | Final overrun |
|---|---:|---:|
| Before `8.ts`, around `5.75s` | none | `+1.005s` |
| Inside `8.ts`, around `6.44s` | none | `+1.004s` |
| After `8.ts`, around `7.41s` | none | `+2.003s` |
| Before `8.ts` | about 3s | `+9.637s` |
| Inside `8.ts` | about 2s | `+9.639s` |
| After `8.ts` | about 2s | `+10.641s` |

Starting after the deficient segment adds about one second even without
construction playback. Playing then causes a much larger mapping change because
Safari advances decoding and expands lookahead across many later anomalies.
The large change cannot be attributed solely to crossing `8.ts`.

### Zero-duration declarations are a primary source of Safari's hidden time

The original `cutemonkey` playlist assigns `8.ts` `EXTINF:0.000`, even though
the segment contains approximately `1.005s` of audio and advances the transport
timestamp sequence by approximately one second.

This corrects an earlier description: `8.ts` does **not** have a normal
one-second `EXTINF`. Safari's approximately `+1s` state is consistent with
reconciling media time that the playlist assigned zero duration.

Two copied variants changed `8.ts` to `EXTINF:1.000`:

1. `EXT-X-GAP`, reserving one playlist second while telling clients not to load
   the URI.
2. Discontinuities before and after `8.ts`, reserving one second while loading
   it as an isolated epoch.

| Variant | Construction playback | Final over playlist |
|---|---:|---:|
| Original zero-duration playlist | none | about `+1.001s` |
| Original zero-duration playlist | `750ms` | about `+5.404s` |
| GAP, one-second `EXTINF` | none | about `-0.003s` |
| GAP, one-second `EXTINF` | `750ms` | about `+0.000s` |
| Discontinuity, one-second `EXTINF` | none | about `-0.003s` |
| Discontinuity, one-second `EXTINF` | `750ms` | about `-0.002s` |
| GAP, one-second `EXTINF` | `2000ms` | about `+5.850s` |
| Discontinuity, one-second `EXTINF` | `2000ms` | about `+5.809s` |

Reserving the first hidden second removes the early +1/+5.4 states. After two
seconds of construction playback, later zero/partial-duration anomalies are
already involved and still produce approximately 5.8 seconds of hidden time.
The added discontinuities supplied no endpoint advantage over correcting the
duration.

### Correct `EXTINF` preserves a deficient-video interval

Zero-discontinuity control:

`/home/visar/Videos/downloads/tango/editor/edited/2026-03-07 152354 elliie/playlist.m3u8`

Its `189.ts` has playlist `EXTINF:3.000`, approximately `2.924s` of audio, and
approximately `0.000011s` of decodable video.

Original, GAP, and artificial-discontinuity playlists all ended within about
1–9ms of the `247.941s` playlist total. Their intermediate behavior differed:

- Original: `currentTime` advanced continuously through the three-second
  deficient-video interval.
- GAP: `currentTime` also advanced continuously through the reserved interval.
- Artificial discontinuities: `currentTime` jumped from approximately
  `189.267s` to `192.154s` in one approximately 250ms sample interval.

The discontinuity variant skips nearly three seconds in the visible timeline
while retaining a convincing endpoint. Endpoint agreement is therefore
insufficient for WYSIWYG editing.

For deficient video with a continuous timestamp sequence, artificial
discontinuities are harmful. Correct playlist duration is more important than
isolating the segment into timestamp epochs.

### Under-declaration alone creates history-dependent hidden time

A fifth `elliie` copy changed only:

```diff
-#EXTINF:3.000000,
+#EXTINF:0.000000,
 189.ts
```

The media bytes, timestamp sequence, surrounding segments, and absence of
discontinuities were unchanged. The shortened playlist total became
`244.941333s`.

| Construction path | Ended time | Over shortened playlist |
|---|---:|---:|
| Start before `189.ts`, do not decode it, seek tail | `244.945246s` | `+0.003913s` |
| Start before `189.ts`, decode through it, seek tail | `247.945809s` | `+3.004476s` |
| Initialize after `189.ts`, seek tail | `247.874000s` | `+2.932667s` |

The original correctly declared playlist ended around `247.946s` in all
corresponding paths.

This proves, without discontinuities or multiple defects, that:

1. Safari initially exposes the shortened playlist coordinate space.
2. If the under-declared media interval does not participate in construction,
   the shortened endpoint remains.
3. Decoding through or initializing after the segment admits approximately its
   real three seconds into the native media timeline.
4. `seekable.end()` still remains on the shortened `244.941s` manifest
   coordinate.

Under-declaration is therefore sufficient to produce the core “Safari plays
past the playlist/UI” behavior and its dependence on session history.

### The downloader currently creates this under-declaration

The current downloader path is:

1. `MediaValidator.getMediaInfo()` ffprobes format, video, and audio duration.
2. It chooses the first positive value in
   `[videoDuration, audioDuration, formatDuration]`.
3. Provider validation returns that selected duration.
4. `PlaylistManager` writes it with three decimal places.

For a segment such as `8.ts`, approximately `0.000011s` of video is technically
positive, so it wins over approximately one second of audio. Formatting to three
decimal places produces `EXTINF:0.000`.

This is a concrete authoring bug. “Positive video duration” is not sufficient
evidence that video duration describes the segment's presentation interval.
Decoded video coverage, audio coverage, transport-clock advancement, and
presentation duration are distinct measurements.

### Adopted downloader writer: per-segment `max(videoDuration, audioDuration)`

Five isolated copies rewrote every segment to:

```text
EXTINF = max(ffprobe video duration, ffprobe audio duration)
```

The writer also recomputed `TARGETDURATION`. Original media bytes were
unchanged.

Static effects:

| Fixture | Original total | Max-A/V total | Added |
|---|---:|---:|---:|
| Tango `cutemonkey` | `602.881s` | `616.431793s` | `13.550793s` |
| Tango `master-hawk` | `1702.430s` | `1773.622795s` | `71.192795s` |
| Tango `bellabr1` control | `600.228333s` | `602.702605s` | `2.474272s` |
| Tango `elliie` control | `247.941333s` | `248.943479s` | `1.002146s` |
| FC2 16-discontinuity control | `1261.000s` | `1261.346710s` | `0.346710s` |

Safari A/B results:

| Fixture | Original tail/beginning error | Max-A/V tail/beginning error |
|---|---|---|
| `cutemonkey` | about `+0.002s / +6.851s` | about `-0.058s / -0.017s` |
| `bellabr1` | about `+0.004s / -0.000s` | about `-0.055s / -0.020s` |
| `elliie` | about `+0.009s / +0.008s` | about `-0.027s / -0.022s` |
| `master-hawk` | about `+0.295s / +1.075s` | about `-0.132s / -0.032s` |
| FC2 control | about `-0.095s / -0.097s` | about `-0.099s / -0.098s` |

Max-A/V makes endpoints agree with the new playlists, including the known-bad
fixtures. It also lengthens every stable control. That lengthening is not by
itself evidence of incorrect behavior: if Safari and WYSIWYG editing continue
to select the correct underlying segments, the longer coordinate can be valid.

Two effects remain useful targets for editor regression tests:

1. Normal AAC packetization often makes an individual segment's reported audio
   duration approximately 20–26ms longer than its one-second transport/video
   advancement. Taking the maximum independently for every segment sums
   overlapping audio packet coverage repeatedly.
2. Some discontinuity-tail segments contain extreme audio tails. In
   `master-hawk`, individual max-A/V increases include approximately `9.482s`,
   `8.825s`, `8.438s`, `4.122s`, and `3.913s`.

Safari ending near the rewritten total proves that playlist durations influence
its coordinate construction. It does not by itself prove every editor boundary,
so WYSIWYG editing remains a separate regression target.

The user-visible `bellabr1` comparison looked correct despite the additional
approximately 2.47 seconds. Together with the pathological-tail tests below,
this supported adopting max-A/V for new Tango and FC2 downloads.

A user-visible `bellabr1` retest started both playlists at exactly
`594.228333s`:

| Playlist | Initial native duration | Final native time | Wall time to end |
|---|---:|---:|---:|
| Original | `600.228s` | `600.232243s` | `5.811s` |
| Max-A/V | `602.702s` | `602.639322s` | `8.221s` |

The max-A/V copy therefore played approximately `2.410s` longer from the same
numeric start. The declared total increased by approximately `2.474s`; Safari
ended the max-A/V copy approximately `0.063s` before that declaration.

A user-visible `cutemonkey` retest initialized both versions at the beginning
for two seconds and then sought to each playlist's own six-second tail:

| Playlist | Declared total | Tail wall time | Final native time |
|---|---:|---:|---:|
| Original | `602.881s` | `12.855s` | `609.729501s` |
| Max-A/V | `616.431793s` | `5.992s` | `616.414056s` |

For this observable failure, max-A/V is a clear improvement: the original
played almost 6.85 hidden seconds beyond its seekable endpoint, while the
max-A/V tail behaved like an actual six-second tail and ended within about
18ms of its declaration.

### Max-A/V editor plumbing test — accuracy not yet proven

A dry run on `master-hawk` compared the overlay's playlist-derived segment with
the segments Safari requested after seeks at 20%, 40%, 60%, 80%, and 94%.
For both the original and max-A/V playlists, the displayed/predicted segment
was present in Safari's requested segment run at every tested position.

A real UI edit then used the disposable max-A/V copy:

- first marker: `1064.208015s`, displayed `2293.ts`;
- second marker: `1067.048344s`, displayed `2296.ts`;
- editor calculation: keep `2293.ts`, `2294.ts`, `2295.ts`, `2296.ts`;
- backend edited playlist: exactly those four segments;
- resulting playlist duration: approximately `4.086s`;
- Safari replay wall time: `4.081s`;
- Safari final media time: `4.064401s`;
- final displayed segment: `2296.ts`.

This confirms that the max-A/V playlist, frontend marker calculation, backend
segment execution, and resulting short clip were internally consistent for this
interval.

It does **not** prove editor accuracy. Marker times were chosen from the same
max-A/V playlist later used to calculate the kept segments. The test therefore
did not independently prove that Safari's visible frames at those times
actually originated from `2293.ts–2296.ts`. Treating it as an accuracy test
would be circular.

A later A/B retained the same source bytes (`2146.ts`, `2147.ts`, `2148.ts`,
and `2155.ts`) in two edited outputs. This was a representation check rather
than an editor-accuracy test because the displayed segment labels were used as
the selection oracle:

| Source timeline | Edited playlist total | Safari final time |
|---|---:|---:|
| Original video-first durations | `5.469s` | about `14.900s` |
| Max-A/V durations | `15.012s` | about `14.899s` |

The original timeline hid approximately 9.43 seconds of media Safari presented.
Max-A/V described the same bytes within approximately 113ms. This directly
supports max-A/V as the downloader writer rule, while a content-based marker
test remains the non-circular way to validate editing.

A valid accuracy test requires independent frame-to-source-segment ground truth:

1. Choose an intended source segment range before observing playlist marker
   calculations.
2. Extract visual fingerprints/reference frames from those source segments.
3. On both original and max-A/V copies, locate the Safari `currentTime` at which
   those frames are actually visible.
4. Click the real marker UI at those Safari times.
5. Compare the backend-kept segment names with the originally chosen source
   range.

### Safari does not blindly preserve raw video PTS gaps

Fixture:

`/home/visar/Videos/downloads/tango/editor/edited/2026-06-25 223318 queensara5/playlist.m3u8`

Properties:

- No `#EXT-X-DISCONTINUITY`.
- Playlist duration: `566.034s`.
- ffprobe video span: `639.432333s`.
- ffprobe audio span: `639.400211s`.
- One approximately `73.224667s` video PTS jump after `68.ts`, at playlist
  position `66.952s`.

Safari buffered media from both sides of that jump. Nevertheless:

- `currentTime` advanced normally through the corresponding playlist position.
- `duration` stayed around `566.034s`.
- `seekable.end()` stayed around `566.034s`.
- Tail seeking continued to use the playlist-scale timeline.

Safari therefore recognized and compressed this enormous untagged timestamp
jump. Replacing `#EXTINF` with the raw adjacent video-PTS advancement would
incorrectly add approximately 73 seconds.

### Discontinuity count alone does not predict the problem

FC2 controls:

- A zero-discontinuity recording had stable fresh/prefix results around
  playlist duration minus `0.087s`.
- A recording with 16 discontinuities had stable fresh/prefix results around
  playlist duration minus `0.097s`.

SC fMP4 control:

- A zero-discontinuity fMP4 recording had stable fresh/prefix results around
  playlist duration minus `0.071s`.

Tango `cutemonkey`, by contrast, changed by approximately `7.43s` between two
media-session histories. Therefore neither the number of discontinuities nor
the presence of discontinuities by itself explains Safari's mapping.

### ffprobe's raw span and the current repairer do not model Safari

The current historical repairer uses adjacent video PTS advancement inside a
continuity section and stream duration at section tails. This produces a useful
description of the raw media timestamps, but it is not a proven description of
Safari's native HLS timeline.

Counterexamples:

| Fixture | Playlist | Repaired total | Observed Safari behavior |
|---|---:|---:|---|
| Tango `arielaq` | `599.724s` | `600.111333s` | Ends near `599.7305s` in both tested paths |
| Tango `queensara5` 2026-06-25 | `566.034s` | `639.432333s` | Safari compresses the 73.225s PTS jump |
| Tango `cutemonkey` 2026-07-20 | `602.881s` | `608.123032s` | Ends around `603.885s` or `611.315s`, depending on history |

The repairer predicts neither `cutemonkey` outcome. For `arielaq` and the
73-second `queensara5` fixture, it adds time Safari does not expose.

The statement in `decisions.md` that video PTS advancement is the canonical
Safari timeline is therefore under review. It was supported by an important
historical fixture, but it is not a general rule across the current corpus.
Do not perform another corpus-wide repair based on that assumption until this
investigation produces a better rule.

## Current fixture evidence

### `master-hawk`

Path:

`/home/visar/Videos/downloads/tango/downloader/2026-07-29 002241 master-hawk-433365/playlist.m3u8`

- Playlist duration: approximately `1702.430s`.
- Segments: 1679.
- Discontinuities: 7.
- Sum of video stream durations: approximately `1702.046s`.
- Sum of per-section video spans: approximately `1727.535s`.
- Sum of per-section audio spans: approximately `1766.760s`.
- The old repair algorithm proposes `1727.535s`, adding `25.105s`.
- Tail segment `2981.ts` is ordinary:
  - playlist `0.481s`;
  - video `0.480667s`;
  - audio `0.491333s`.
- Some other discontinuity-tail segments have misleading audio spans. For
  example, `2148.ts` has about `2.506667s` of video but `11.989333s` of audio.

This fixture proves history-dependent Safari endpoints, but its many
discontinuities and malformed audio tails make it poor for isolating a single
rule.

### `cutemonkey-81756`, 2026-07-20

Path:

`/home/visar/Videos/downloads/tango/downloader/2026-07-20 210536 cutemonkey-81756/playlist.m3u8`

- Playlist duration: `602.881s`.
- Segments: 609.
- Discontinuities: 5, at playlist positions approximately `88.855`,
  `89.722`, `97.587`, `160.542`, and `193.403`.
- Sum of per-section video spans: `608.123032s`.
- Sum of per-section audio spans: `613.744266s`.
- The earlier analysis called approximately `5.170003s` of differences
  “positive video PTS gaps.” That description was incomplete. It measured
  `next video start - current video start - decoded current video duration`.
  Several large values arise because the current segment contains almost no
  decodable video, not because the next timestamp jumps unexpectedly.
- Examples:
  - `8.ts`: video duration about `0.000011s`, audio duration about `1.005211s`;
  - `263.ts`: video duration about `0.000011s`;
  - `502.ts`: video duration about `0.000011s`;
  - `295.ts`: video duration about `0.433333s`;
  - `298.ts`: video duration about `0.166333s`;
  - `312.ts`: video duration about `0.633333s`.
- For `8.ts -> 9.ts`, video start timestamps advance by the expected one second.
  The anomaly is missing video coverage inside `8.ts`, while audio and the
  transport timestamp cadence continue.
- The original playlist assigns `8.ts` zero duration. This under-declaration,
  not merely the deficient video frame, is essential to the hidden-time result.
- The first nearly-empty video segment is at playlist position about 6 seconds,
  before the first declared discontinuity.
- The controlled Safari endpoints are listed in the table above. The original
  less-controlled values (`603.885s` and `611.315s`) are superseded.

Independent and concatenated ffprobe decoding agree that `8.ts` contains one
corrupt/degenerate video frame rather than a hidden one-second run that only
requires the previous segment's decoder state. Each surrounding segment begins
with an I-frame, and concatenated probing still reports only the one frame for
`8.ts`. This rules out the initial suspicion that per-file probing alone created
the missing-video observation.

This is the best currently known positive fixture for studying initialization
history.

### `arielaq`, 2026-05-20

Path:

`/home/visar/Videos/downloads/tango/editor/edited/2026-05-20 204009 arielaq/playlist.m3u8`

- Playlist duration: `599.724s`.
- No discontinuities.
- Video span: `600.111333s`.
- Two notable positive video gaps: approximately `98.667ms` and `66.667ms`.
- Safari ended about `6.5ms` beyond the playlist in both tested paths.

This is a repairer false-positive control: raw PTS advancement adds `387ms`
that Safari does not preserve.

### `queensara5`, 2026-05-23

Path:

`/home/visar/Videos/downloads/tango/editor/edited/2026-05-23 200746 queensara5/playlist.m3u8`

- Playlist duration: `379.085s`.
- Two discontinuities very near the tail, around `375.819s` and `376.452s`.
- Before those discontinuities, the first continuity section contains several
  moderate gaps:
  - approximately `0.600s` at playlist position `94.336s`;
  - approximately `1.000s` at `140.055s`;
  - additional approximately `1.000s` gaps later.
- Video spans total approximately `386.913s`.

This fixture separates repeated moderate PTS gaps from discontinuity handling:
most gaps occur hundreds of seconds before the two declared discontinuities.

### `alena-2403`, 2026-07-03

Path:

`/home/visar/Videos/downloads/tango/downloader/2026-07-03 094115 alena-2403/playlist.m3u8`

- Playlist duration: approximately `1799.149s`.
- No discontinuities.
- Video span: approximately `1802.153333s`.
- Numerous distributed gaps around `33–67ms`.

This is the accumulated-small-gap fixture.

### Stable controls

- Tango:
  `/home/visar/Videos/downloads/tango/editor/edited/2026-03-17 120056 bellabr1/playlist.m3u8`
- FC2, no discontinuities:
  `/home/visar/Videos/downloads/fc2/editor/edited/2026-06-02 180653 26780549/playlist.m3u8`
- FC2, 16 discontinuities:
  `/home/visar/Videos/downloads/fc2/editor/edited/2026-04-24 173851 26780549/playlist.m3u8`
- SC fMP4:
  `/home/visar/Videos/downloads/sc/editor/edited/2026-06-20 071832 yu_nya/playlist.m3u8`

## Rejected models

### Rejected: `sum(#EXTINF)` always describes Safari playback

`master-hawk` and `cutemonkey` can play beyond that sum, with
history-dependent endpoints.

### Rejected: sum raw video PTS advancement

The 73-second `queensara5` gap is compressed by Safari. `arielaq` is another
smaller counterexample.

### Rejected: sum video stream durations

This loses timestamp gaps and discontinuity behavior and does not reproduce the
observed positive Safari overruns.

### Rejected: use audio as the authority

Some Tango segments contain long audio tails unrelated to the visible video
timeline. The audio spans for `master-hawk` and `cutemonkey` are much larger
than any consistently observed Safari endpoint.

### Rejected: add every positive decoded-video coverage deficit above a fixed threshold

Safari compresses a 73-second gap, ignores `arielaq`'s roughly 99ms and 67ms
deficits, yet exposes additional time in other files. Furthermore, some
apparent gaps are nearly empty video segments with continuous audio and
continuous next-segment timestamps. Magnitude alone is not sufficient.

### Rejected: count or sum discontinuities

FC2 with 16 discontinuities is stable, while Tango behavior varies. The content
of timestamp epochs around a boundary matters more than the tag count.

### Rejected: add discontinuities around deficient-video segments

The `elliie` control has continuous timestamps and a correct three-second
`EXTINF`. Adding discontinuities around its deficient-video segment makes
Safari jump across nearly the whole interval while leaving the endpoint
apparently correct.

## Provisional model

The best current working model is:

1. `#EXTINF` defines Safari's initial seekable coordinate space.
2. Safari examines MPEG timestamps as it fetches and demuxes segments.
3. Safari can normalize an untagged timestamp jump onto the playlist
   coordinate space instead of preserving the raw hole.
4. Under some combinations of incomplete video coverage, continuous audio,
   timestamp jumps, and discontinuity epochs, Safari establishes a different
   internal mapping.
5. That mapping belongs to the lifetime of the native media element. Reloading
   can choose a different mapping; ordinary seeking does not necessarily rebuild
   it.
6. `duration` may be revised as additional tail media is decoded, while
   `seekable.end()` remains on the playlist coordinate space.
7. The region used to initialize the media element is a confirmed input to the
   mapping. On `cutemonkey`, six controlled initial regions produced five
   distinct endpoints.
8. Advancing decode/playback can revise the mapping even when the exposed
   buffered range is unchanged.
9. A segment assigned too little or zero `EXTINF` can contribute hidden media
   time. Correcting the declaration removed the corresponding early endpoint
   offset in the tested `cutemonkey` copies.
10. Correct endpoint and seekable values do not imply a correct intermediate
    mapping. Artificial discontinuities can create large `currentTime` jumps
    without moving the final endpoint.
11. Under-declared media time is a confirmed sufficient cause. Safari admits
    that time after decoding through it or initializing beyond it, while
    retaining the manifest-scale seekable endpoint.

Items 2–6 describe observed behavior but the exact decision rule is unknown.
In particular, it is not yet known whether the mapping changes because Safari:

- crosses a timestamp boundary during playback;
- merely buffers/demuxes the boundary;
- sees a new declared discontinuity epoch;
- reconciles audio and video timestamps;
- applies a gap-normalization threshold that depends on surrounding cadence; or
- anchors its media time to the first epoch loaded after a nonzero start.

The evidence now weighs against “merely buffers the boundary” as a complete
explanation. Equivalent `buffered` intervals can lead to different mappings.
Decode progress or presented-sample progress matters.

The working model can now be stated more narrowly:

- The manifest builds the initial public seek coordinate.
- Media intervals omitted or shortened by `EXTINF` are initially absent from
  that coordinate.
- Once Safari constructs playback using samples beyond such an interval, its
  native media time can include the omitted interval.
- A later seek expressed in manifest coordinates then lands in a media timeline
  that contains additional admitted time, allowing playback beyond
  `seekable.end()`.
- Multiple under-declared intervals make the result depend on which portions
  were decoded before the seek.

This model explains the controlled single-defect `elliie` experiment. It still
needs to predict the exact discrete states of multi-defect `cutemonkey`.

## Relevant external specifications and implementation guidance

An internet research pass on 2026-07-29 did not uncover a public WebKit formula
for this behavior. Safari native HLS is backed by Apple's media stack, and the
observable web properties do not expose its internal timestamp-epoch mapping.
The published rules nevertheless identify concrete authoring violations in the
fixtures.

Apple's [HLS authoring specification for Apple
devices](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/)
requires the `EXTINF` sum of every contiguous group of segments to remain within
one video frame of the actual content duration. It also requires encoding
continuity breaks to be marked with `EXT-X-DISCONTINUITY`.

[RFC 8216](https://www.rfc-editor.org/rfc/rfc8216.html) says
`EXT-X-DISCONTINUITY` is mandatory when the timestamp sequence changes. The
current [HLS 2nd Edition
draft](https://datatracker.ietf.org/doc/draft-pantos-hls-rfc8216bis/) further
states that:

- segmenting should occur on packet/key-frame boundaries that permit effective
  independent decoding;
- absent media must be represented by gap segments carrying `EXT-X-GAP`;
- timing-information changes must be signalled with
  `EXT-X-DISCONTINUITY`.

Apple's [MPEG-TS preparation
guidance](https://developer.apple.com/documentation/http-live-streaming/preparing-audio-for-http-live-streaming)
also stresses that MPEG-TS audio and video use arbitrary 33-bit timestamp
clocks and must be aligned, including leading audio.

These sources do not define what Safari must do with a segment containing one
corrupt video frame plus a full second of audio. The source media is outside the
valid authoring envelope, so Safari's history-dependent recovery should not be
assumed to be a stable or portable timeline algorithm.

`EXT-X-GAP` is not an immediate fix for `8.ts`: that tag describes a segment URI
that contains no media and tells clients not to load it. `8.ts` contains valid
audio and some video data. The copied GAP variant is therefore diagnostic, not
a production-correct transformation: it discards that audio while reserving its
time.

The GAP experiment stabilized the tested timeline, but the `elliie` original
showed that GAP is unnecessary when `EXTINF` already accounts for the interval.
Preserving valid audio with an accurate duration is preferable to falsely
declaring the entire segment absent.

## Experimental discipline

### Current copied test fixtures

These folders are deliberate test artifacts. Their media files are hard-linked
to the originals, but every copied `playlist.m3u8` has its own inode:

- `2026-07-20 210536 cutemonkey-81756 safari-gap8`
- `2026-07-20 210536 cutemonkey-81756 safari-disc8`
- `2026-03-07 152354 elliie safari-gap189`
- `2026-03-07 152354 elliie safari-disc189`
- `2026-03-07 152354 elliie safari-zero189`
- `2026-07-20 210536 cutemonkey-81756 safari-maxav`
- `2026-07-29 002241 master-hawk-433365 safari-maxav`
- `2026-03-17 120056 bellabr1 safari-maxav`
- `2026-03-07 152354 elliie safari-maxav`
- FC2: `2026-04-24 173851 26780549 safari-maxav`

They live beside the corresponding Tango original/edited recordings and are
visible through the normal API. Do not treat them as user recordings or feed
them into batch playlist repair.

### Native startup position must be controlled before viewer navigation

Setting `video.currentTime` after the viewer loads is not equivalent to starting
the media element at that position. Safari may already have requested and
demuxed enough media to establish a mapping.

Progress persistence introduces another trap: `pagehide` saves the current
video time and can overwrite a test value immediately before reload.

For controlled cases:

1. Navigate natively back to the provider list.
2. On the list document, set or clear the exact `video-progress-{filename}`
   value.
3. Navigate normally to the video.
4. Verify the first buffered range and initial `currentTime` before interpreting
   the case.

Do not label a case “fresh tail” merely because the test issued a tail seek
quickly after reload.

### Separate fetched, buffered, played, and decoded

Record all of:

- requested segment names;
- `buffered` ranges;
- `played` ranges;
- `currentTime`;
- `duration`;
- `seekable`;
- `readyState`;
- `ended`;
- wall-clock time.

A large buffered range proves Safari accepted media across a boundary. It does
not prove every buffered frame was presented.

### Capture packet clocks at every tested boundary

ffprobe aggregate stream fields are not enough. For the segment before and
after each boundary record:

- first and last video PTS;
- first and last video DTS;
- first and last audio PTS;
- codec time bases;
- packet/frame duration and cadence;
- whether PTS or DTS wraps or moves backward;
- playlist `EXTINF`;
- whether `#EXT-X-DISCONTINUITY` precedes the second segment.

Safari may be reacting to decode timestamps, audio anchoring, or timestamp
rollover behavior that `stream=start_time,duration` summaries conceal.

### Reload between construction paths

Repeated seeks in one media element test an established mapping. They do not
test how Safari initially constructs that mapping. Every construction-path case
requires a new document/media element.

## Next focused phone matrix

### Phase 1: `cutemonkey` early initialization — completed

Use native list-to-viewer navigation with these initial saved positions:

| Start | Purpose |
|---:|---|
| tail near `596.881s` | Tail-only mapping |
| `0s` | Beginning mapping |
| `4s` | Decode across first approximately 1s gap near 6s |
| `8s` | Initialize after that gap without crossing it |
| `86s` | Cross first declared discontinuity at `88.855s` |
| `91s` | Initialize after the first short discontinuity epochs |

This matrix was completed. Its results are recorded in “Safari's final mapping
can depend on media-session history.”

The nearly-empty `8.ts` refinement and the 0–2 second decode-progress refinement
are also complete. Their results are recorded above.

### Phase 1b: no-discontinuity corrupt-video control — completed

`elliie` supplied this control. Correct `EXTINF` was sufficient for stable
intermediate progression and endpoints despite deficient video. GAP remained
stable but would discard valid audio. Artificial discontinuities broke
intermediate progression.

### Phase 1c: enumerate under-declared segments

The next corpus analysis should distinguish raw timestamp advancement, audio
coverage, video coverage, playlist `EXTINF`, and declared discontinuities.

Rank segments where `EXTINF` is materially shorter than the continuous media
clock or audio coverage. Test whether the sum of *under-declared* intervals,
rather than all video PTS advancement, predicts Safari's discrete endpoint
states.

The single-defect zero-duration `elliie` variant confirms that
under-declaration is sufficient. The remaining work is to define a robust
per-segment “real media interval” in the presence of:

- valid audio with deficient video;
- corrupt or exaggerated audio tails;
- declared discontinuities;
- genuine timestamp jumps that Safari compresses;
- a final segment with no following timestamp anchor.

### Phase 2: moderate gaps without nearby discontinuities

Use `queensara5` 2026-05-23:

- tail-only;
- start around `92s` and cross the approximately `0.600s` gap;
- start around `96s`, after that gap;
- start around `138s` and cross the approximately `1.000s` gap;
- start around `142s`, after that gap.

The declared discontinuities occur near 376 seconds, so these cases test
moderate untagged gaps independently.

### Phase 3: accumulated small gaps

Use `alena-2403`:

- tail-only;
- beginning initialization;
- initialize before and after a known 33–67ms gap;
- initialize late, after Safari has the opportunity to encounter many such
  gaps.

This determines whether small discrepancies accumulate or are normalized
locally.

### Phase 4: clean replay controls

Repeat one Tango clean control and the FC2 16-discontinuity control using the
same navigation and measurement procedure. This catches test-harness effects
and prevents a Safari cache/session artifact from being mistaken for a media
rule.

## Decision gate

Do not change playlist repair again merely to match one endpoint. A replacement
rule must:

1. Predict all controlled construction paths, or explicitly explain why Safari
   has multiple valid mappings.
2. Map intermediate visible playback positions to the correct segment.
3. Handle discontinuities and untagged timestamp jumps.
4. Avoid treating long audio tails as visible video.
5. Be validated on Tango, FC2, and SC controls.

If Safari's mapping is genuinely history-dependent and cannot be represented by
one static HLS playlist timeline, the correct outcome may be to normalize the
media timestamps during capture/remuxing rather than infer a better set of
`#EXTINF` values afterward.
