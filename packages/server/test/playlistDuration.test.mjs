import assert from "node:assert/strict";
import test from "node:test";
import { selectLongestMediaDuration } from "shared";
import {
    dropFmp4FragmentsFromPlaylist,
    dropRegressedCompoundSegments,
    dropSegmentsFromPlaylist,
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

test("dropping consecutive MPEG-TS segments inserts one discontinuity at the gap", () => {
    const result = dropSegmentsFromPlaylist(MEDIA_PLAYLIST, new Set(["2.ts", "3.ts", "missing.ts"]));

    assert.deepEqual(result.removedSegmentNames, ["2.ts", "3.ts"]);
    assert.deepEqual(result.missingSegmentNames, ["missing.ts"]);
    assert.equal(result.insertedDiscontinuityCount, 1);
    assert.equal(result.content.includes("2.ts"), false);
    assert.equal(result.content.includes("3.ts"), false);
    assert.match(result.content, /1\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:1\.000000,\n4\.ts/);
    assert.match(result.content, /#EXT-X-ENDLIST\n$/);
});

test("dropping separate MPEG-TS segments marks both timeline gaps", () => {
    const result = dropSegmentsFromPlaylist(MEDIA_PLAYLIST, new Set(["1.ts", "3.ts"]));

    assert.equal(result.insertedDiscontinuityCount, 2);
    assert.match(result.content, /#EXT-X-DISCONTINUITY\n#EXTINF:1\.000000,\n2\.ts/);
    assert.match(result.content, /#EXT-X-DISCONTINUITY\n#EXTINF:1\.000000,\n4\.ts/);
});

test("individual fMP4 fragments are never dropped by the MPEG-TS repair", () => {
    const fmp4 = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
1.m4s
#EXT-X-ENDLIST
`;
    assert.throws(() => dropSegmentsFromPlaylist(fmp4, new Set(["1.m4s"])), /fMP4/);
});

test("attributed fMP4 fragments are dropped with a renewed map at the discontinuity", () => {
    const fmp4 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:8
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2,
5.ts
#EXTINF:8,
6.ts
#EXTINF:2,
7.ts
#EXT-X-ENDLIST
`;
    const result = dropFmp4FragmentsFromPlaylist(fmp4, new Set(["6.ts"]));

    assert.deepEqual(result.removedSegmentNames, ["6.ts"]);
    assert.equal(result.insertedDiscontinuityCount, 1);
    assert.equal(result.content.includes("6.ts"), false);
    assert.match(
        result.content,
        /5\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init\.mp4"\n#EXTINF:2\.000000,\n7\.ts/,
    );
});

test("fMP4 repair renews the active initialization map after dropping a map-transition fragment", () => {
    const fmp4 = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2,
1.m4s
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="init_2.mp4"
#EXTINF:2,
2.m4s
#EXTINF:2,
3.m4s
#EXT-X-ENDLIST
`;
    const result = dropFmp4FragmentsFromPlaylist(fmp4, new Set(["2.m4s"]));

    assert.match(
        result.content,
        /1\.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init_2\.mp4"\n#EXTINF:2\.000000,\n3\.m4s/,
    );
});

test("compound HLS media-sequence regressions are removed without sorting", () => {
    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:2
#EXT-X-TARGETDURATION:1
#EXTINF:1,
0_fc2-start_2.ts
#EXTINF:1,
1_fc2-start_3.ts
#EXT-X-DISCONTINUITY
#EXTINF:1,
2_fc2-start_2.ts
#EXT-X-DISCONTINUITY
#EXTINF:1,
3_fc2-start_4.ts
#EXTINF:1,
4_fc2-start_3.ts
#EXT-X-ENDLIST
`;
    const result = dropRegressedCompoundSegments(playlist);

    assert.deepEqual(result.removedSegmentNames, ["2_fc2-start_2.ts", "4_fc2-start_3.ts"]);
    assert.deepEqual(
        [...result.content.matchAll(/^\d+_fc2-start_(\d+)\.ts$/gm)].map((match) => Number(match[1])),
        [2, 3, 4],
    );
    assert.match(result.content, /#EXT-X-ENDLIST\n$/);
});

test("legacy and fMP4 playlists are outside compound sequence repair", () => {
    const legacy = dropRegressedCompoundSegments(MEDIA_PLAYLIST);
    assert.equal(legacy.content, MEDIA_PLAYLIST);
    assert.equal(legacy.skippedReason, "legacy-or-mixed-names");

    const fmp4 = dropRegressedCompoundSegments(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
0_stream_1.ts
#EXT-X-ENDLIST
`);
    assert.equal(fmp4.removedSegmentNames.length, 0);
    assert.equal(fmp4.skippedReason, "fmp4-map");
});
