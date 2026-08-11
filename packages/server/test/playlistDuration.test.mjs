import assert from "node:assert/strict";
import test from "node:test";
import { selectLongestMediaDuration } from "shared";
import { requiresFfprobeFallback } from "../dist/services/hls/playlistAuthority.js";

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
