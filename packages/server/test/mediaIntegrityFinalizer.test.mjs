import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
    buildFfmpegValidationArgs,
    collectMediaDecodeErrors,
    finalizeMediaIntegrity,
    MediaIntegrityQueue,
    mediaDecodeErrors,
} from "../dist/services/hls/mediaIntegrityFinalizer.js";

const PLAYLIST_HEADER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
`;

async function createStream(t, playlist) {
    const streamPath = await mkdtemp(path.join(tmpdir(), "media-integrity-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(streamPath, { recursive: true })));
    await writeFile(path.join(streamPath, "playlist.m3u8"), playlist);
    await Promise.all(["1.ts", "2.ts", "3.ts"].map(name =>
        writeFile(path.join(streamPath, name), Buffer.alloc(188, 0x47))
    ));
    return streamPath;
}

test("null muxer DTS bookkeeping is not classified as decoded-media corruption", () => {
    const timestampError = "[null] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 4 >= 4";
    const decoderError = "[h264] corrupt decoded frame";

    assert.equal(mediaDecodeErrors(timestampError), "");
    assert.equal(mediaDecodeErrors(`${timestampError}\n${decoderError}`), decoderError);

    const noisyChunks = [
        Buffer.from(`${timestampError}\n`.repeat(300)),
        Buffer.from(`${decoderError}\n`),
    ];
    assert.equal(collectMediaDecodeErrors(noisyChunks), decoderError);
});

test("ffmpeg validation accepts recordings with only video or only audio", () => {
    const args = buildFfmpegValidationArgs("playlist.m3u8");
    assert.equal(args.includes("[0:v:0]"), false);
    assert.deepEqual(
        args.filter((value, index) => args[index - 1] === "-map"),
        ["0:v?", "0:a?"],
    );
});

test("media-integrity queue deduplicates paths and runs one stream at a time", async () => {
    const started = [];
    const releases = [];
    let activeCount = 0;
    let maxActiveCount = 0;
    const queue = new MediaIntegrityQueue(async streamPath => {
        started.push(streamPath);
        activeCount++;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise(resolve => releases.push(resolve));
        activeCount--;
    }, 0, 1);

    assert.equal(queue.enqueue("first"), true);
    assert.equal(queue.enqueue("first"), false);
    assert.equal(queue.enqueue("second"), true);
    assert.deepEqual(started, ["first"]);

    releases.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ["first", "second"]);

    releases.shift()();
    await queue.onIdle();
    assert.equal(maxActiveCount, 1);
    assert.equal(queue.depth, 0);
});

test("media-integrity queue honors its configured worker limit", async () => {
    const releases = [];
    let activeCount = 0;
    let maxActiveCount = 0;
    const queue = new MediaIntegrityQueue(async () => {
        activeCount++;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise(resolve => releases.push(resolve));
        activeCount--;
    }, 0, 2);

    queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("third");
    assert.equal(activeCount, 2);

    releases.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activeCount, 2);

    for (const release of releases.splice(0)) release();
    await new Promise(resolve => setImmediate(resolve));
    for (const release of releases.splice(0)) release();
    await queue.onIdle();
    assert.equal(maxActiveCount, 2);
});

test("finalized clean playlist uses whole-playlist validation without scanning every segment", async (t) => {
    const streamPath = await createStream(t, `${PLAYLIST_HEADER}#EXTINF:1,
1.ts
#EXTINF:1,
2.ts
#EXTINF:1,
3.ts
#EXT-X-ENDLIST
`);
    const validated = [];

    const result = await finalizeMediaIntegrity(streamPath, {
        validateMedia: async inputPath => {
            validated.push(path.basename(inputPath));
            return { valid: true, exitCode: 0, stderr: "" };
        },
    });

    assert.equal(result.kind, "processed");
    assert.equal(result.report.status, "ready");
    assert.equal(result.report.deepScannedSegmentCount, 0);
    assert.deepEqual(result.report.invalidSegments, []);
    assert.deepEqual(validated, ["playlist.m3u8"]);

    const revalidated = await finalizeMediaIntegrity(streamPath, {
        revalidate: true,
        validateMedia: async inputPath => {
            validated.push(path.basename(inputPath));
            return { valid: true, exitCode: 0, stderr: "" };
        },
    });
    assert.equal(revalidated.kind, "processed");
    assert.deepEqual(validated, ["playlist.m3u8", "playlist.m3u8"]);
});

test("failed whole-playlist validation reports exact bad segments without changing media", async (t) => {
    const originalPlaylist = `${PLAYLIST_HEADER}#EXTINF:1,
1.ts
#EXTINF:1,
2.ts
#EXTINF:1,
3.ts
#EXT-X-ENDLIST
`;
    const streamPath = await createStream(t, originalPlaylist);

    const result = await finalizeMediaIntegrity(streamPath, {
        validateMedia: async inputPath => {
            const name = path.basename(inputPath);
            if (name === "2.ts") {
                return { valid: false, exitCode: 183, stderr: "corrupt decoded frame" };
            }
            if (name === "playlist.m3u8") {
                const content = await readFile(inputPath, "utf8");
                return content.includes("2.ts")
                    ? { valid: false, exitCode: 183, stderr: "corrupt input packet" }
                    : { valid: true, exitCode: 0, stderr: "" };
            }
            return { valid: true, exitCode: 0, stderr: "" };
        },
    });

    assert.equal(result.kind, "processed");
    assert.equal(result.report.status, "failed");
    assert.equal(result.report.deepScannedSegmentCount, 3);
    assert.deepEqual(result.report.invalidSegments, [
        { name: "2.ts", error: "corrupt decoded frame" },
    ]);
    assert.equal(await readFile(path.join(streamPath, "playlist.m3u8"), "utf8"), originalPlaylist);
    assert.equal((await stat(path.join(streamPath, "2.ts"))).size, 188);

    const repeated = await finalizeMediaIntegrity(streamPath, {
        validateMedia: async () => {
            throw new Error("completed streams must not be revalidated");
        },
    });
    assert.equal(repeated.kind, "already-processed");
});

test("playlist without ENDLIST remains owned by the downloader", async (t) => {
    const streamPath = await createStream(t, `${PLAYLIST_HEADER}#EXTINF:1,
1.ts
`);

    const result = await finalizeMediaIntegrity(streamPath, {
        validateMedia: async () => {
            throw new Error("active playlist must not be validated");
        },
    });

    assert.deepEqual(result, { kind: "not-finalized" });
});

test("resuming a deep scan continues after the last checkpoint", async (t) => {
    const streamPath = await createStream(t, `${PLAYLIST_HEADER}#EXTINF:1,
1.ts
#EXTINF:1,
2.ts
#EXTINF:1,
3.ts
#EXT-X-ENDLIST
`);
    await writeFile(path.join(streamPath, ".media-integrity.json"), JSON.stringify({
        version: 2,
        status: "processing",
        startedAt: "2026-08-11T00:00:00.000Z",
        completedAt: null,
        playlistPath: path.join(streamPath, "playlist.m3u8"),
        segmentCount: 3,
        initialPlaylistValid: false,
        initialValidationError: "corrupt input packet",
        deepScannedSegmentCount: 2,
        invalidSegments: [{ name: "2.ts", error: "corrupt decoded frame" }],
        error: null,
    }));

    const validated = [];
    const result = await finalizeMediaIntegrity(streamPath, {
        validateMedia: async inputPath => {
            validated.push(path.basename(inputPath));
            return { valid: true, exitCode: 0, stderr: "" };
        },
    });

    assert.equal(result.kind, "processed");
    assert.equal(result.report.segmentCount, 3);
    assert.equal(result.report.deepScannedSegmentCount, 3);
    assert.deepEqual(result.report.invalidSegments, [
        { name: "2.ts", error: "corrupt decoded frame" },
    ]);
    assert.deepEqual(validated, ["3.ts"]);
});
