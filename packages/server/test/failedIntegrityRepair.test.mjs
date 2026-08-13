import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { repairFailedMediaIntegrity } from "../dist/services/hls/failedIntegrityRepair.js";

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1,
1.ts
#EXTINF:1,
2.ts
#EXTINF:1,
3.ts
#EXT-X-ENDLIST
`;

function report(streamPath, status, invalidSegments = []) {
    return {
        version: 2,
        status,
        startedAt: "2026-08-12T00:00:00.000Z",
        completedAt: "2026-08-12T00:01:00.000Z",
        playlistPath: path.join(streamPath, "playlist.m3u8"),
        segmentCount: status === "ready" ? 2 : 3,
        initialPlaylistValid: status === "ready",
        initialValidationError: status === "ready" ? null : "corrupt input packet",
        deepScannedSegmentCount: status === "ready" ? 0 : 3,
        invalidSegments,
        error: null,
    };
}

async function createFailedStream(t) {
    const root = await mkdtemp(path.join(tmpdir(), "failed-integrity-repair-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(root, { recursive: true })));
    const streamPath = path.join(root, "recording");
    const trashPath = path.join(root, "trash");
    await Promise.all([mkdir(streamPath), mkdir(trashPath)]);
    await writeFile(path.join(streamPath, "playlist.m3u8"), PLAYLIST);
    await Promise.all(["1.ts", "2.ts", "3.ts"].map(name => writeFile(path.join(streamPath, name), name)));
    return {
        streamPath,
        trashPath,
        failedReport: report(streamPath, "failed", [{ name: "2.ts", error: "corrupt decoded frame" }]),
    };
}

test("failed integrity repair publishes the safe playlist before moving the exact bad file", async (t) => {
    const { streamPath, trashPath, failedReport } = await createFailedStream(t);
    const observedOrder = [];
    const readyReport = report(streamPath, "ready");

    const result = await repairFailedMediaIntegrity(streamPath, failedReport, {
        repairPlaylist: async () => {
            const playlist = await readFile(path.join(streamPath, "playlist.m3u8"), "utf8");
            assert.equal(playlist.includes("2.ts"), false);
            assert.match(playlist, /1\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:1\.000000,\n3\.ts/);
            observedOrder.push("playlist-repaired");
        },
        dropFile: async filePath => {
            assert.deepEqual(observedOrder, ["playlist-repaired"]);
            assert.equal((await readFile(path.join(streamPath, "playlist.m3u8"), "utf8")).includes("2.ts"), false);
            await rename(filePath, path.join(trashPath, path.basename(filePath)));
            observedOrder.push("file-trashed");
        },
        revalidate: async () => {
            assert.deepEqual(observedOrder, ["playlist-repaired", "file-trashed"]);
            return { kind: "processed", report: readyReport };
        },
    });

    assert.deepEqual(result.removedPlaylistSegmentNames, ["2.ts"]);
    assert.deepEqual(result.droppedSegmentNames, ["2.ts"]);
    assert.equal(result.dropDestination, "desktop-trash");
    assert.equal(result.insertedDiscontinuityCount, 1);
    assert.equal(result.finalReport.status, "ready");
    await assert.rejects(stat(path.join(streamPath, "2.ts")), { code: "ENOENT" });
    assert.equal((await stat(path.join(trashPath, "2.ts"))).isFile(), true);
});

test("failed integrity repair safely resumes after playlist publication and file movement", async (t) => {
    const { streamPath, trashPath, failedReport } = await createFailedStream(t);
    await rename(path.join(streamPath, "2.ts"), path.join(trashPath, "2.ts"));
    await writeFile(
        path.join(streamPath, "playlist.m3u8"),
        `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n1.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\n3.ts\n#EXT-X-ENDLIST\n`,
    );

    const result = await repairFailedMediaIntegrity(streamPath, failedReport, {
        repairPlaylist: async () => {},
        dropFile: async () => assert.fail("an already absent source file must not be moved again"),
        revalidate: async () => ({ kind: "processed", report: report(streamPath, "ready") }),
    });

    assert.deepEqual(result.removedPlaylistSegmentNames, []);
    assert.deepEqual(result.alreadyAbsentPlaylistSegmentNames, ["2.ts"]);
    assert.deepEqual(result.droppedSegmentNames, []);
    assert.deepEqual(result.alreadyAbsentFileNames, ["2.ts"]);
});

test("failed fMP4 repair drops only the attributed fragment and republishes its map", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "failed-fmp4-repair-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(root, { recursive: true })));
    const streamPath = path.join(root, "recording");
    const trashPath = path.join(root, "trash");
    await Promise.all([mkdir(streamPath), mkdir(trashPath)]);
    await writeFile(path.join(streamPath, "playlist.m3u8"), `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:8
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2,
1.ts
#EXTINF:8,
2.ts
#EXTINF:2,
3.ts
#EXT-X-ENDLIST
`);
    await Promise.all(["init.mp4", "1.ts", "2.ts", "3.ts"].map(name =>
        writeFile(path.join(streamPath, name), name)
    ));
    const failedReport = report(streamPath, "failed", [
        { name: "2.ts", error: "missing reference picture" },
    ]);

    const result = await repairFailedMediaIntegrity(streamPath, failedReport, {
        repairPlaylist: async () => {},
        dropFile: async filePath => rename(filePath, path.join(trashPath, path.basename(filePath))),
        revalidate: async () => ({ kind: "processed", report: report(streamPath, "ready") }),
    });

    const repaired = await readFile(path.join(streamPath, "playlist.m3u8"), "utf8");
    assert.match(repaired, /1\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init\.mp4"\n#EXTINF:2\.000000,\n3\.ts/);
    assert.deepEqual(result.droppedSegmentNames, ["2.ts"]);
    assert.equal((await stat(path.join(trashPath, "2.ts"))).isFile(), true);
});
