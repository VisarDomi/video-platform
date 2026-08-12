import assert from "node:assert/strict";
import test from "node:test";

import { deriveEditedPlaylist } from "../dist/services/video/edit.service.js";

const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:1,
0.ts
#EXTINF:1,
1_stream_1.ts
#EXT-X-DISCONTINUITY
#EXTINF:1,
2_stream_0.ts
#EXTINF:1,
3_stream_1.ts
#EXT-X-ENDLIST
`;

test("editing preserves names and inserts discontinuity across a cut", () => {
    const result = deriveEditedPlaylist(playlist, new Set(["0.ts", "2_stream_0.ts", "3_stream_1.ts"]));
    assert.equal(result.keptSegmentCount, 3);
    assert.match(result.content, /0\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\n2_stream_0\.ts/);
    assert.match(result.content, /2_stream_0\.ts\n#EXTINF:1,\n3_stream_1\.ts/);
    assert.doesNotMatch(result.content, /1_stream_1\.ts/);
});

test("source discontinuity survives when the first segment after it is cut", () => {
    const result = deriveEditedPlaylist(playlist, new Set(["1_stream_1.ts", "3_stream_1.ts"]));
    assert.match(result.content, /1_stream_1\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\n3_stream_1\.ts/);
});
