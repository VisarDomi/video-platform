import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The server's folders and its state follow these; set before any of its modules load.
const home = await mkdtemp(path.join(os.tmpdir(), "move-checkpoint-"));
process.env.HOME = home;
process.env.VIDEO_DOWNLOADS_ROOT = path.join(home, "downloads");
process.env.VIDEO_SERVICES_DATA_ROOT = path.join(home, "services");
test.after(() => rm(home, { recursive: true, force: true }));

const { FinalizationCheckpointStore, playlistFingerprint } = await import("../dist/services/hls/finalizationCheckpointStore.js");
const { configureProviders, getProviderPaths } = await import("../dist/core/config.js");
const { moveVideo } = await import("../dist/services/video/move.service.js");

const PLAYLIST = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n0.ts\n#EXT-X-ENDLIST\n";

function ready(recordingPath) {
    return {
        version: 2,
        status: "ready",
        playlistPath: path.join(recordingPath, "playlist.m3u8"),
        segmentCount: 1,
        invalidSegments: [],
        error: null,
    };
}

async function recording(folder) {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "playlist.m3u8"), PLAYLIST);
    await writeFile(path.join(folder, "0.ts"), "segment");
}

test("a ready checkpoint is carried to the new path, and only a ready one with the same playlist", async () => {
    const store = new FinalizationCheckpointStore(path.join(home, "carry.sqlite"));
    try {
        const fingerprint = playlistFingerprint(PLAYLIST);
        store.write("/r/downloaded/rec", fingerprint, ready("/r/downloaded/rec"));
        assert.equal(store.carry("/r/downloaded/rec", "/r/edited/rec", "other-playlist"), false);
        assert.equal(store.carry("/r/downloaded/rec", "/r/edited/rec", fingerprint), true);
        const carried = store.read("/r/edited/rec", fingerprint);
        assert.equal(carried.status, "ready");
        assert.equal(carried.playlistPath, "/r/edited/rec/playlist.m3u8");
        assert.equal(carried.movedFrom, "/r/downloaded/rec");
        store.write("/r/downloaded/failed", fingerprint, { version: 2, status: "failed" });
        assert.equal(store.carry("/r/downloaded/failed", "/r/edited/failed", fingerprint), false);
        assert.equal(store.read("/r/edited/failed", fingerprint), null);
    } finally {
        store.close();
    }
});

test("finalize-library adopts the checkpoint of a recording moved without one", async () => {
    const store = new FinalizationCheckpointStore(path.join(home, "adopt.sqlite"));
    try {
        const fingerprint = playlistFingerprint(PLAYLIST);
        store.write("/r/downloaded/2026-09-01 120000 alias", fingerprint, ready("/r/downloaded/2026-09-01 120000 alias"));
        assert.equal(store.adoptMoved("/r/edited/2026-09-01 120000 alias", "different"), null);
        assert.equal(store.adoptMoved("/r/edited/2026-09-01 120000 other", fingerprint), null);
        assert.equal(store.adoptMoved("/r/edited/2026-09-01 120000 alias", fingerprint),
            "/r/downloaded/2026-09-01 120000 alias");
        assert.equal(store.read("/r/edited/2026-09-01 120000 alias", fingerprint).status, "ready");
        // A path that has a row of its own keeps it.
        assert.equal(store.adoptMoved("/r/edited/2026-09-01 120000 alias", fingerprint), null);
    } finally {
        store.close();
    }
});

test("saving a recording moves its checkpoint, so the pipeline can upload it", async () => {
    configureProviders(["live-a"]);
    const paths = getProviderPaths("live-a");
    const database = path.join(home, "move.sqlite");
    const name = "2026-11-21 080000 alias";
    const source = path.join(paths.downloaded, name);
    await recording(source);
    const store = new FinalizationCheckpointStore(database);
    store.write(source, playlistFingerprint(PLAYLIST), ready(source));
    store.close();

    await moveVideo({ filename: name, provider: "live-a", type: "original", dirPath: source }, "edited",
        { finalizationDatabasePath: database });

    const saved = path.join(paths.edited, name);
    assert.equal(await readFile(path.join(saved, "playlist.m3u8"), "utf8"), PLAYLIST);
    await assert.rejects(stat(source), { code: "ENOENT" });
    const after = new FinalizationCheckpointStore(database);
    try {
        const report = after.read(saved, playlistFingerprint(PLAYLIST));
        assert.equal(report.status, "ready");
        assert.equal(report.playlistPath, path.join(saved, "playlist.m3u8"));
        assert.equal(after.read(source, playlistFingerprint(PLAYLIST)), null);
    } finally {
        after.close();
    }

    // A recording that never had one moves as before, with nothing invented for it.
    const bare = path.join(paths.downloaded, "2026-11-21 090000 alias");
    await recording(bare);
    await moveVideo({ filename: path.basename(bare), provider: "live-a", type: "original", dirPath: bare }, "edited",
        { finalizationDatabasePath: database });
    const check = new FinalizationCheckpointStore(database);
    try {
        assert.equal(check.read(path.join(paths.edited, path.basename(bare)), playlistFingerprint(PLAYLIST)), null);
    } finally {
        check.close();
    }
});
