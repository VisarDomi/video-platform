import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
    findUnreferencedMediaFiles,
    processFinalizedRecording,
} from "../dist/services/hls/finalizedRecordingProcessor.js";
import {
    FinalizationCheckpointStore,
    playlistFingerprint,
} from "../dist/services/hls/finalizationCheckpointStore.js";
import { pendingRecordingDisposition } from "../dist/services/hls/mediaIntegrityFinalizer.js";

const readyReport = {
    version: 2,
    status: "ready",
    invalidSegments: [],
};

async function temporaryRecording(t, files, playlist) {
    const root = await mkdtemp(path.join(os.tmpdir(), "finalized-recording-"));
    t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
    const recording = path.join(root, "recording");
    await mkdir(recording);
    for (const name of files) await writeFile(path.join(recording, name), `media ${name}`);
    await writeFile(path.join(recording, "playlist.m3u8"), playlist);
    const checkpointStore = new FinalizationCheckpointStore(path.join(root, "finalization.sqlite"));
    t.after(() => checkpointStore.close());
    return { root, recording, checkpointStore };
}

const uris = async (recording) => (await readFile(path.join(recording, "playlist.m3u8"), "utf8"))
    .split("\n").filter((line) => line !== "" && !line.startsWith("#"));
const valid = { valid: true, exitCode: 0, stderr: "" };

test("finalized processing repairs the playlist, lists unreferenced media, then validates with the findings", async () => {
    const trace = [];
    const result = await processFinalizedRecording("/recording", {}, {
        repairPlaylist: async () => {
            trace.push("repair-playlist");
            return [{ kind: "sequence-restart", message: "restart", names: ["2_r_1.ts"] }];
        },
        listUnreferenced: async () => {
            trace.push("list-unreferenced");
            return ["5_r_9.ts"];
        },
        validate: async (_streamPath, options) => {
            trace.push("validate");
            assert.deepEqual(options.findings.map((finding) => finding.kind), ["sequence-restart", "unreferenced-media"]);
            assert.deepEqual(options.findings[1].names, ["5_r_9.ts"]);
            return { kind: "processed", report: readyReport };
        },
    });
    assert.deepEqual(trace, ["repair-playlist", "list-unreferenced", "validate"]);
    assert.equal(result.report.status, "ready");
});

test("an unchanged ready checkpoint skips duration repair, listing, and decode", async (t) => {
    const playlist = ["#EXTM3U", "#EXTINF:1,", "0.ts", "#EXT-X-ENDLIST", ""].join("\n");
    const { recording, checkpointStore } = await temporaryRecording(t, [], playlist);
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
    const result = await processFinalizedRecording(recording, { checkpointStore }, {
        listUnreferenced: unexpected,
        repairPlaylist: unexpected,
        validate: unexpected,
    });

    assert.equal(result.kind, "already-processed");
    assert.equal(result.report.status, "ready");
});

test("unreferenced segments and maps stay on disk and are listed as warnings", async (t) => {
    const files = ["init.mp4", "init_1.mp4", "0_stream_1.ts", "1_stream_2.ts", "2_stream_3.m4s", "notes.mp4"];
    const { recording, checkpointStore } = await temporaryRecording(t, files, [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:1",
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:1,",
        "0_stream_1.ts",
        "#EXT-X-ENDLIST",
        "",
    ].join("\n"));
    assert.deepEqual(await findUnreferencedMediaFiles(recording), ["1_stream_2.ts", "2_stream_3.m4s", "init_1.mp4"]);

    const result = await processFinalizedRecording(recording, {
        checkpointStore,
        validateMedia: async () => valid,
        inspectFragment: async () => null,
    });

    assert.equal(result.report.status, "ready");
    const warning = result.report.warnings.find((item) => item.kind === "unreferenced-media");
    assert.deepEqual(warning.names, ["1_stream_2.ts", "2_stream_3.m4s", "init_1.mp4"]);
    assert.deepEqual((await readdir(recording)).sort(), [...files, "playlist.m3u8"].sort());
    assert.equal(pendingRecordingDisposition(result.report), "publish");
});

test("damaged MPEG-TS segments are kept in the playlist and on disk, and the recording is ready with warnings", async (t) => {
    const names = ["0_rec_10.ts", "1_rec_11.ts", "2_rec_12.ts"];
    const { recording, checkpointStore } = await temporaryRecording(t, names, [
        "#EXTM3U", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:10",
        ...names.flatMap((name) => ["#EXTINF:1,", name]),
        "#EXT-X-ENDLIST", "",
    ].join("\n"));
    const damaged = { valid: false, exitCode: 183, stderr: "corrupt decoded frame" };

    const result = await processFinalizedRecording(recording, {
        checkpointStore,
        validateMedia: async (input) =>
            path.basename(input) === "playlist.m3u8" || path.basename(input) === "1_rec_11.ts" ? damaged : valid,
    });

    assert.equal(result.report.version, 2);
    assert.equal(result.report.status, "ready");
    assert.equal(result.report.error, null);
    assert.deepEqual(result.report.invalidSegments, [{ name: "1_rec_11.ts", error: "corrupt decoded frame" }]);
    const warning = result.report.warnings.find((item) => item.kind === "damaged-segments");
    assert.deepEqual(warning.names, ["1_rec_11.ts"]);
    assert.deepEqual(await uris(recording), names);
    assert.deepEqual((await readdir(recording)).sort(), [...names, "playlist.m3u8"].sort());
    assert.equal(pendingRecordingDisposition(result.report), "publish");
    // The pipeline contract reads the checkpoint of the current playlist.
    const stored = checkpointStore.read(recording, playlistFingerprint(await readFile(path.join(recording, "playlist.m3u8"), "utf8")));
    assert.equal(stored.status, "ready");
});

test("regressed provider sequences are kept, in order, behind one discontinuity", async (t) => {
    const names = ["0_rec_1111.ts", "1_rec_1112.ts", "2_rec_1.ts", "3_rec_2.ts"];
    const { recording, checkpointStore } = await temporaryRecording(t, names, [
        "#EXTM3U", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:1111",
        ...names.flatMap((name) => ["#EXTINF:1,", name]),
        "#EXT-X-ENDLIST", "",
    ].join("\n"));

    const result = await processFinalizedRecording(recording, { checkpointStore, validateMedia: async () => valid });

    assert.equal(result.report.status, "ready");
    assert.deepEqual(await uris(recording), names);
    assert.match(await readFile(path.join(recording, "playlist.m3u8"), "utf8"),
        /1_rec_1112\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:[\d.]+,\n2_rec_1\.ts/);
    const warning = result.report.warnings.find((item) => item.kind === "sequence-restart");
    assert.deepEqual(warning.names, ["2_rec_1.ts"]);
    assert.deepEqual((await readdir(recording)).sort(), [...names, "playlist.m3u8"].sort());
});

// A power loss leaves entries whose files never got their data (empty, or
// still all zero bytes) and NUL bytes in the playlist. Such an entry holds no
// media: it leaves the playlist, and its file stays on disk.
test("entries whose files hold no bytes leave the playlist, with a boundary where media resumes", async (t) => {
    const names = ["0_rec_10.ts", "1_rec_11.ts", "2_rec_12.ts", "3_rec_13.ts", "4_rec_14.ts"];
    const { recording, checkpointStore } = await temporaryRecording(t, [names[0], names[3]], [
        "#EXTM3U", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:10",
        ...names.flatMap((name) => ["#EXTINF:1,", name]),
        "\0".repeat(200),
        "#EXT-X-ENDLIST", "",
    ].join("\n"));
    await writeFile(path.join(recording, names[1]), Buffer.alloc(0));
    await writeFile(path.join(recording, names[2]), Buffer.alloc(4096));
    await writeFile(path.join(recording, names[4]), Buffer.alloc(0));

    const result = await processFinalizedRecording(recording, { checkpointStore, validateMedia: async () => valid });

    assert.equal(result.report.status, "ready");
    const playlist = await readFile(path.join(recording, "playlist.m3u8"), "utf8");
    assert.doesNotMatch(playlist, /\0/);
    assert.deepEqual(await uris(recording), [names[0], names[3]]);
    assert.match(playlist, /0_rec_10\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:[\d.]+,\n3_rec_13\.ts\n#EXT-X-ENDLIST\n$/);
    const dropped = result.report.warnings.find((item) => item.kind === "empty-entries");
    assert.deepEqual(dropped.names, [names[1], names[2], names[4]]);
    assert.deepEqual(result.report.warnings.find((item) => item.kind === "unreferenced-media").names,
        [names[1], names[2], names[4]]);
    assert.deepEqual((await readdir(recording)).sort(), [...names, "playlist.m3u8"].sort());
});

test("an empty fMP4 entry hands its map and boundary to the next entry", async (t) => {
    const files = ["init.mp4", "init_2.mp4", "0_rec_10.ts", "2_rec_12.ts"];
    const { recording, checkpointStore } = await temporaryRecording(t, files, [
        "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:10",
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:2.000,", "0_rec_10.ts",
        "#EXT-X-DISCONTINUITY", '#EXT-X-MAP:URI="init_2.mp4"',
        "#EXTINF:2.000,", "1_rec_11.ts",
        "#EXTINF:2.000,", "2_rec_12.ts",
        "#EXT-X-ENDLIST", "",
    ].join("\n"));
    await writeFile(path.join(recording, "1_rec_11.ts"), Buffer.alloc(0));

    const result = await processFinalizedRecording(recording, {
        checkpointStore, validateMedia: async () => valid, inspectFragment: async () => null,
    });

    assert.equal(result.report.status, "ready");
    assert.match(await readFile(path.join(recording, "playlist.m3u8"), "utf8"),
        /0_rec_10\.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init_2\.mp4"\n#EXTINF:2\.000,\n2_rec_12\.ts\n#EXT-X-ENDLIST\n$/);
    assert.deepEqual(result.report.warnings.find((item) => item.kind === "empty-entries").names, ["1_rec_11.ts"]);
});

test("only a playlist without entries and without unreferenced media segments may be discarded", () => {
    const report = (status, warnings = []) => ({ version: 2, status, invalidSegments: [], warnings });
    assert.equal(pendingRecordingDisposition(report("ready", [{ kind: "validation-incomplete", message: "x" }])), "publish");
    assert.equal(pendingRecordingDisposition(report("failed")), "retry");
    assert.equal(pendingRecordingDisposition(report("empty")), "discard-empty");
    assert.equal(pendingRecordingDisposition(report("empty",
        [{ kind: "unreferenced-media", message: "x", names: ["init.mp4", "init_3_1.mp4"] }])), "discard-empty");
    assert.equal(pendingRecordingDisposition(report("empty",
        [{ kind: "unreferenced-media", message: "x", names: ["init.mp4", "0_rec_5.ts"] }])), "publish");
});

for (const phase of ["planned", "verified", "published"]) {
    test(`a retired destructive repair journal (${phase}) is cleared without moving files`, async (t) => {
        const names = ["0.ts", "1.ts", "2.ts"];
        const original = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n0.ts\n#EXTINF:1,\n1.ts\n#EXTINF:1,\n2.ts\n#EXT-X-ENDLIST\n";
        const candidate = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n0.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\n2.ts\n#EXT-X-ENDLIST\n";
        const onDisk = phase === "published" ? candidate : original;
        const { root, recording, checkpointStore } = await temporaryRecording(t, names, onDisk);
        const database = new DatabaseSync(path.join(root, "finalization.sqlite"));
        database.prepare("INSERT INTO media_repairs VALUES (?, ?, ?)").run(path.resolve(recording), JSON.stringify({
            report: { version: 2, status: "failed" }, originalPlaylist: original, candidatePlaylist: candidate,
            invalidSegmentNames: ["1.ts"], phase,
        }), new Date().toISOString());
        database.close();
        // Ready evidence for the on-disk playlist must not hide the journal.
        checkpointStore.write(recording, playlistFingerprint(onDisk), { ...readyReport, segmentCount: 2 });

        const result = await processFinalizedRecording(recording, {
            checkpointStore,
            validateMedia: async () => valid,
        }, { repairPlaylist: async () => [] });

        assert.equal(checkpointStore.readRepair(recording), null);
        assert.equal(result.report.status, "ready");
        assert.equal(await readFile(path.join(recording, "playlist.m3u8"), "utf8"), onDisk);
        assert.deepEqual((await readdir(recording)).sort(), [...names, "playlist.m3u8"].sort());
        const kinds = result.report.warnings.map((warning) => warning.kind);
        assert.equal(kinds.includes("retired-repair-journal"), true);
        assert.equal(kinds.includes("unreferenced-media"), phase === "published");
    });
}
