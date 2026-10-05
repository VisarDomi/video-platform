import assert from "node:assert/strict";
import test from "node:test";
import { selectLongestMediaDuration } from "shared";
import {
    markCompoundSequenceRestarts,
    requiresFfprobeFallback,
} from "../dist/services/hls/playlistAuthority.js";

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,
1.ts
#EXTINF:1,
2.ts
#EXTINF:1,
3.ts
#EXTINF:1,
4.ts
#EXT-X-ENDLIST
`;

test("playlist duration uses audio when botched video barely advances", () => {
    assert.equal(
        selectLongestMediaDuration(0.000011, 1.025211, 1.076211),
        1.025211,
    );
});

test("playlist duration uses the longest positive media stream", () => {
    assert.equal(selectLongestMediaDuration(1.2, 1.0, 1.3), 1.2);
    assert.equal(selectLongestMediaDuration(1.0, 1.2, 1.3), 1.2);
});

test("playlist duration uses container duration only without positive media durations", () => {
    assert.equal(selectLongestMediaDuration(null, Number.NaN, 1.076211), 1.076211);
    assert.equal(selectLongestMediaDuration(0, -1, 0), null);
});

test("adjacent video PTS avoids per-segment ffprobe fallback", () => {
    assert.equal(requiresFfprobeFallback(1.01, "video-timeline", true), false);
    assert.equal(requiresFfprobeFallback(1.01, "stream-duration", true), true);
    assert.equal(requiresFfprobeFallback(null, "missing", true), true);
});

test("compound media-sequence restarts are kept in order; only a missing discontinuity is added", () => {
    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:1111
#EXT-X-TARGETDURATION:1
#EXTINF:1,
0_fc2-start_1111.ts
#EXTINF:1,
1_fc2-start_1112.ts
#EXTINF:1,
2_fc2-start_1.ts
#EXTINF:1,
3_fc2-start_2.ts
#EXT-X-DISCONTINUITY
#EXTINF:1,
4_fc2-start_0.ts
#EXT-X-ENDLIST
`;
    const result = markCompoundSequenceRestarts(playlist);

    assert.deepEqual(result.restartSegmentNames, ["2_fc2-start_1.ts", "4_fc2-start_0.ts"]);
    assert.equal(result.insertedDiscontinuityCount, 1);
    assert.equal(result.content, playlist.replace("1_fc2-start_1112.ts\n", "1_fc2-start_1112.ts\n#EXT-X-DISCONTINUITY\n"));
});

test("an fMP4 restart gets its discontinuity before the map; legacy names are left alone", () => {
    const fmp4 = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2,
0_sc_693.ts
#EXT-X-MAP:URI="init_1.mp4"
#EXTINF:2,
1_sc_26.ts
#EXT-X-ENDLIST
`;
    const result = markCompoundSequenceRestarts(fmp4);
    assert.deepEqual(result.restartSegmentNames, ["1_sc_26.ts"]);
    assert.match(result.content, /0_sc_693\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init_1\.mp4"\n#EXTINF:2,\n1_sc_26\.ts/);

    const legacy = markCompoundSequenceRestarts(MEDIA_PLAYLIST);
    assert.equal(legacy.content, MEDIA_PLAYLIST);
    assert.equal(legacy.skippedReason, "legacy-or-mixed-names");
});

