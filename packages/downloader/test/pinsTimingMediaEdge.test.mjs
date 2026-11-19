// Pinning tests: the generic capture loop's timings and media naming. The loop's
// timings are load-bearing (a single default loses media in a few seconds of live
// window); the local names are read by the server, the pipeline and the players.
// Change them only on purpose.
//
// Each real site's timings, flags and edge naming are pinned with its plug-in
// (private/test/pinsTimingMediaEdge.test.mjs), with the same expected values.
//
// Already pinned elsewhere, not repeated here:
//   formatSegmentName / UTC recording IDs / percent-encoded names: segmentIdentity.test.mjs
//   init.mp4, init_N.mp4, init_N_k.mp4: initTracker.test.mjs, segmentIdentity.test.mjs
//   60 s terminal rule between 30 s and 60 s: activeRecordingReconciler.test.mjs (the exact edge is below)
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Nothing below may touch the real download folders or lists.
const sandbox = await mkdtemp(path.join(os.tmpdir(), "pins-downloader-"));
process.env.VIDEO_DOWNLOADS_ROOT = path.join(sandbox, "downloads");
process.env.VIDEO_SERVICES_DATA_ROOT = path.join(sandbox, "data");
test.after(() => rm(sandbox, { recursive: true, force: true }));

const timing = await import("../dist/common/timing.js");
const playlistModule = await import("../dist/services/download/playlistManager.js");
const { PlaylistManager } = playlistModule;
const { ActiveRecordingReconciler } = await import("../dist/services/common/activeRecordingReconciler.js");
const { DiskSession } = await import("../dist/services/download/diskSession.js");

const FMP4_LIVE = "https://cdn.fmp4-live.example/b-hls-08/9001/9001_720p.m3u8?psch=v2&pkey=synthetic";

test("pin: timing constants", () => {
    assert.equal(timing.RATE_LIMIT_RETRY_MS, 2_000);
    assert.equal(timing.PLAYLIST_HEDGE_MS, 1_000);
    assert.equal(timing.EDGE_RECOVERY_SLEEP_MS, 5_000);
    assert.equal(timing.QUALITY_CHECK_INTERVAL_MS, 10_000);
    assert.equal(timing.STALE_STREAM_TIMEOUT_MS, 60_000);
    assert.equal(playlistModule.SEQUENCE_RESTART_MARGIN_SEGMENTS, 10);
    assert.equal(playlistModule.SEQUENCE_GAP_LATE_POLL_SECONDS, 3);
    assert.equal(playlistModule.EDGE_DEDUP_MAX_OVERLAP_MS, 60_000);
});

test("pin: an offline recording ends after two observations at least 60 000 ms apart, not 59 999", async () => {
    const finalized = [];
    const manager = {
        hasStreamer: () => false,
        activeSessions: () => [{ streamerId: "30000001", hasMedia: false }],
        async finalizeStreamer(id) { finalized.push(id); return true; },
    };
    const reconciler = new ActiveRecordingReconciler("fmp4", manager, () => null, path.join(sandbox, "no-active-root"));
    const offline = (observedAt) => ({ observedAt, live: new Map(), terminalTargetIds: new Set(["30000001"]) });
    await reconciler.reconcile(offline(0));
    await reconciler.reconcile(offline(59_999));
    assert.deepEqual(finalized, []);
    await reconciler.reconcile(offline(60_000));
    assert.deepEqual(finalized, ["30000001"]);
});

test("pin: local media names for fMP4 fragments end in .ts; the first map becomes init.mp4 (VERSION 7)", async (t) => {
    const root = await mkdtemp(path.join(sandbox, "fmp4-"));
    const handle = { state: { alias: "synthetic_room" }, update(value) { Object.assign(this.state, value); } };
    const manager = new PlaylistManager(new DiskSession("synthetic_room", handle, async () => root, root), "2026-03-04T05:06:07Z");
    const segments = await manager.identifyNewSegments([
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:500",
        '#EXT-X-MAP:URI="init_9001_720p.mp4"',
        "#EXTINF:2.000,",
        "9001_720p_500.m4s",
        "#EXTINF:2.000,",
        "9001_720p_501.mp4?x=1",
        "",
    ].join("\n"), (line) => new URL(line, FMP4_LIVE).href);
    assert.deepEqual(segments.map((segment) => [segment.localName, segment.providerSequence]), [
        ["0_2026-03-04T050607Z_500.ts", 500],
        ["1_2026-03-04T050607Z_501.ts", 501],
    ]);
    for (const segment of segments) await manager.appendSegmentToPlaylist(segment);
    assert.equal(await readFile(path.join(root, "playlist.m3u8"), "utf8"), [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:500",
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:2.000,",
        "0_2026-03-04T050607Z_500.ts",
        "#EXTINF:2.000,",
        "1_2026-03-04T050607Z_501.ts",
        "",
    ].join("\n"));
});
