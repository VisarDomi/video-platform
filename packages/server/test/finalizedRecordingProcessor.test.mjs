import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    moveUnreferencedTransportSegmentsToTrash,
    processFinalizedRecording,
} from "../dist/services/hls/finalizedRecordingProcessor.js";
import {
    FinalizationCheckpointStore,
    playlistFingerprint,
} from "../dist/services/hls/finalizationCheckpointStore.js";

const readyReport = {
    version: 2,
    status: "ready",
    invalidSegments: [],
};

test("finalized processing repairs, cleans newly unreferenced media, then validates", async () => {
    const trace = [];
    const result = await processFinalizedRecording("/recording", {}, {
        cleanup: async () => trace.push("cleanup"),
        repairPlaylist: async () => trace.push("repair-playlist"),
        validate: async () => {
            trace.push("validate");
            return { kind: "processed", report: readyReport };
        },
        repairFailed: async () => {
            throw new Error("unexpected failed repair");
        },
    });
    assert.deepEqual(trace, ["repair-playlist", "cleanup", "validate"]);
    assert.equal(result.report.status, "ready");
});

test("attributable MPEG-TS failure enters the idempotent repair path", async () => {
    const trace = [];
    const failedReport = { version: 2, status: "failed", invalidSegments: [{ name: "1.ts" }] };
    const result = await processFinalizedRecording("/recording", {}, {
        cleanup: async () => trace.push("cleanup"),
        repairPlaylist: async () => trace.push("repair-playlist"),
        validate: async () => {
            trace.push("validate");
            return { kind: "processed", report: failedReport };
        },
        repairFailed: async () => {
            trace.push("repair-failed");
            return { finalReport: readyReport };
        },
    });
    assert.deepEqual(trace, ["repair-playlist", "cleanup", "validate", "repair-failed"]);
    assert.equal(result.report.status, "ready");
});

test("an unchanged ready checkpoint skips cleanup, duration repair, and decode", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "finalized-ready-checkpoint-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recording = path.join(root, "recording");
    await mkdir(recording);
    const playlist = [
        "#EXTM3U",
        "#EXTINF:1,",
        "0.ts",
        "#EXT-X-ENDLIST",
        "",
    ].join("\n");
    await writeFile(path.join(recording, "playlist.m3u8"), playlist);
    const checkpointStore = new FinalizationCheckpointStore(path.join(root, "finalization.sqlite"));
    t.after(() => checkpointStore.close());
    checkpointStore.write(recording, playlistFingerprint(playlist), {
        ...readyReport,
        startedAt: "2026-08-12T00:00:00.000Z",
        completedAt: "2026-08-12T00:00:01.000Z",
        playlistPath: path.join(recording, "playlist.m3u8"),
        segmentCount: 1,
        initialPlaylistValid: true,
        initialValidationError: null,
        deepScannedSegmentCount: 0,
        error: null,
    });

    const unexpected = async () => {
        throw new Error("completed recording work should have been skipped");
    };
    const result = await processFinalizedRecording(recording, {
        checkpointStore,
        retryFailed: true,
    }, {
        cleanup: unexpected,
        repairPlaylist: unexpected,
        validate: unexpected,
        repairFailed: unexpected,
    });

    assert.equal(result.kind, "already-processed");
    assert.equal(result.report.status, "ready");
});

test("cleanup keeps playlist media and maps while trashing only unreferenced owned artifacts", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "finalized-cleanup-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recording = path.join(root, "recording");
    const trash = path.join(root, "trash");
    await Promise.all([mkdir(recording), mkdir(trash)]);
    await writeFile(path.join(recording, "playlist.m3u8"), [
        "#EXTM3U",
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:1,",
        "0_stream_1.ts",
        "#EXT-X-ENDLIST",
        "",
    ].join("\n"));
    for (const name of ["init.mp4", "init_1.mp4", "0_stream_1.ts", "1_stream_2.ts", "notes.mp4"]) {
        await writeFile(path.join(recording, name), name);
    }

    await moveUnreferencedTransportSegmentsToTrash(recording, async (filePath) => {
        await rename(filePath, path.join(trash, path.basename(filePath)));
    });

    assert.deepEqual((await readdir(recording)).sort(), [
        "0_stream_1.ts",
        "init.mp4",
        "notes.mp4",
        "playlist.m3u8",
    ]);
    assert.deepEqual((await readdir(trash)).sort(), ["1_stream_2.ts", "init_1.mp4"]);
});
