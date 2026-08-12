import assert from "node:assert/strict";
import test from "node:test";
import { selectLongestMediaDuration } from "shared";
import {
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
