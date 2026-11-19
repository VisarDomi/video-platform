// Pinning tests: per-site timings, media naming and FMP4 edge naming as the generic
// capture loop sees them today. Per-site timings are load-bearing (a single
// default loses media in a few seconds of live window); the local names are
// read by the server, the pipeline and the players; the edge rules decide when
// duplicate segments are skipped. Change them only on purpose.
//
// Already pinned elsewhere, not repeated here:
//   TsLive never refreshes the master during a capture: tsliveLifecycle.test.mjs
//   formatSegmentName / UTC recording IDs / percent-encoded names: segmentIdentity.test.mjs
//   init.mp4, init_N.mp4, init_N_k.mp4: initTracker.test.mjs, segmentIdentity.test.mjs
//   60 s terminal rule between 30 s and 60 s: activeRecordingReconciler.test.mjs (the exact edge is below)
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import timersPromises from "node:timers/promises";

// Nothing below may touch the real download folders or lists.
const sandbox = await mkdtemp(path.join(os.tmpdir(), "pins-downloader-"));
process.env.VIDEO_DOWNLOADS_ROOT = path.join(sandbox, "downloads");
process.env.VIDEO_SERVICES_DATA_ROOT = path.join(sandbox, "data");
test.after(() => rm(sandbox, { recursive: true, force: true }));

const timing = await import("../dist/common/timing.js");
const playlistModule = await import("../dist/services/download/playlistManager.js");
const { PlaylistManager } = playlistModule;
const { ApiClient } = await import("../dist/services/tslive/api/apiClient.js");
const { LadderClient } = await import("../dist/services/ladder/api/ladderClient.js");
const { ScClient } = await import("../dist/services/fmp4/api/scClient.js");
const { StreamDiscoveryService } = await import("../dist/services/tslive/discovery/streamDiscoveryService.js");
const { LadderDiscoveryService } = await import("../dist/services/ladder/discovery/discoveryService.js");
const { ScDiscoveryService } = await import("../dist/services/fmp4/discovery/discoveryService.js");
const { StreamDownloader } = await import("../dist/services/download/streamDownloader.js");
const { AccessIncidentTracker } = await import("../dist/services/download/accessIncidentTracker.js");
const { PlaylistNotFoundError } = await import("../dist/services/core/playlistNotFoundError.js");
const { ActiveRecordingReconciler } = await import("../dist/services/common/activeRecordingReconciler.js");
const { DiskSession } = await import("../dist/services/download/diskSession.js");

// Synthetic URL shapes. FMP4 media URLs carry the edge as a "b-hls-NN" path segment.
const FMP4_LIVE = "https://cdn.fmp4-live.example/b-hls-08/9001/9001_720p.m3u8?psch=v2&pkey=synthetic";
const TSLIVE_LIVE = "https://cdn.tslive.example.test/v2/stream/9001/high.m3u8?token=synthetic";
const LADDER_LIVE = "https://edge.ladder.example.test/a/stream/9001/playlist.m3u8?hls_key=synthetic";

const tokens = async () => ({ st: "synthetic-st", tt: "synthetic-tt", ttu: "synthetic-ttu", tte: "9999999999" });
function ladderClient(t) {
    const client = new LadderClient();
    t.after(() => clearInterval(client.cleanupInterval));
    return client;
}

// The capture code sleeps through timers/promises. Replace it for one test:
// "park" leaves every sleep pending (a discovery loop stops after one poll),
// "resolve" returns at once; sleeps with an abort signal (the playlist hedge,
// polling while a segment downloads) never fire and reject when aborted.
function recordSleeps(t, mode) {
    const sleeps = [];
    const signalled = [];
    const original = timersPromises.setTimeout;
    timersPromises.setTimeout = (ms, value, options) => {
        if (options?.signal) {
            signalled.push(ms);
            return new Promise((_resolve, reject) => options.signal.addEventListener("abort",
                () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
        }
        sleeps.push(ms);
        return mode === "park" ? new Promise(() => {}) : Promise.resolve(value);
    };
    syncBuiltinESMExports();
    t.after(() => {
        timersPromises.setTimeout = original;
        syncBuiltinESMExports();
    });
    return { sleeps, signalled };
}

async function until(check) {
    for (let n = 0; n < 200 && !check(); n++) await new Promise((resolve) => setImmediate(resolve));
    assert(check(), "condition not reached");
}

const idleReconciler = {
    recoverLocalState: async () => {},
    endRemovedSessions: async () => {},
    reconcile: async () => ({ resumePaths: new Map() }),
};

test("pin: timing constants", () => {
    assert.equal(timing.TSLIVE_POLL_MS, 1_000);
    assert.equal(timing.LADDER_POLL_MS, 30_000);
    assert.equal(timing.LADDER_DISCOVERY_RETRY_MS, 1_000);
    assert.equal(timing.FMP4_POLL_MS, 5_000);
    assert.equal(timing.FMP4_IDENTITY_REFRESH_MS, 60_000);
    assert.equal(timing.RATE_LIMIT_RETRY_MS, 2_000);
    assert.equal(timing.PLAYLIST_HEDGE_MS, 1_000);
    assert.equal(timing.EDGE_RECOVERY_SLEEP_MS, 5_000);
    assert.equal(timing.QUALITY_CHECK_INTERVAL_MS, 10_000);
    assert.equal(timing.STALE_STREAM_TIMEOUT_MS, 60_000);
    assert.equal(playlistModule.SEQUENCE_RESTART_MARGIN_SEGMENTS, 10);
    assert.equal(playlistModule.SEQUENCE_GAP_LATE_POLL_SECONDS, 3);
    assert.equal(playlistModule.EDGE_DEDUP_MAX_OVERLAP_MS, 60_000);
});

test("pin: per-site provider flags (only TsLive overrides the loop's defaults)", (t) => {
    const tslive = new ApiClient(tokens);
    assert.equal(tslive.providerName, "tslive");
    assert.equal(tslive.playlistRetryMs, 1_000);
    assert.equal(tslive.refreshMasterDuringDownload, false);
    for (const client of [ladderClient(t), new ScClient()]) {
        assert.equal(client.playlistRetryMs, undefined, `${client.providerName} uses the 5 s default`);
        assert.equal(client.refreshMasterDuringDownload, undefined, `${client.providerName} re-checks the master`);
    }
});

test("pin: discovery cadence TsLive 1 s, LADDER 30 s from the start of the poll, FMP4 5 s", async (t) => {
    const { sleeps } = recordSleeps(t, "park");
    let now = 1_000_000;
    t.mock.method(Date, "now", () => now);
    const manager = { size: 0, activeSessions: () => [], hasStreamer: () => false };

    const tslive = new StreamDiscoveryService({ getLiveStreamsByAccountIds: async () => null },
        { getTargets: () => [] }, manager);
    tslive.activeReconciler = idleReconciler;
    void tslive.start();
    await until(() => sleeps.length === 1);
    assert.deepEqual(sleeps, [1_000]);

    const ladder = new LadderDiscoveryService({ getTargets: () => [] }, {}, manager);
    ladder.activeReconciler = { ...idleReconciler, endRemovedSessions: async () => { now += 1_234; } };
    ladder.start();
    await until(() => sleeps.length === 2);
    assert.equal(sleeps[1], 30_000 - 1_234, "LADDER waits 30 s from when the poll started");

    const fmp4 = new ScDiscoveryService({ getTargets: () => [] }, {}, manager);
    fmp4.activeReconciler = idleReconciler;
    fmp4.start();
    await until(() => sleeps.length === 3);
    assert.equal(sleeps[2], 5_000);
});

test("pin: FMP4 re-reads a live room's identity every 60 s, not sooner", async (t) => {
    let now = 5_000_000;
    t.mock.method(Date, "now", () => now);
    const refreshed = [];
    const client = {
        checkStatusBulk: async () => new Map([["30000001", { status: "public", isLive: true }]]),
        getKnownRecordingId: () => "2026-03-04T05:06:07Z",
        refreshTarget: async (roomId, username) => {
            refreshed.push(now);
            return { username, streamName: "synthetic_stream", statusChangedAt: "2026-03-04T05:06:07Z" };
        },
    };
    const manager = { getRecordingId: () => "2026-03-04T05:06:07Z", hasStreamer: () => true };
    const service = new ScDiscoveryService(
        { getTargets: () => [{ roomId: "30000001", username: "synthetic_room" }] }, client, manager);
    service.activeReconciler = idleReconciler;
    await service.poll();
    assert.deepEqual(refreshed, [5_000_000], "first sight of a live room reads its identity");
    now += 59_999;
    await service.poll();
    assert.equal(refreshed.length, 1);
    now += 1;
    await service.poll();
    assert.deepEqual(refreshed, [5_000_000, 5_060_000]);
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

function captureHandle(liveUrl = null) {
    return {
        masterPlaylistUrl: "https://master.example.test/master.m3u8",
        state: { alias: "synthetic_alias", streamerId: "9001", recordingId: "synthetic-recording", liveUrl },
        update(value) { Object.assign(this.state, value); },
    };
}
const playlistStub = () => ({ setEdge() {}, onEdgeSwitch() {}, timeline: { edge: null } });

test("pin: TsLive retries a failed live playlist after 1 s; requests are hedged after 1 s", async (t) => {
    const { sleeps, signalled } = recordSleeps(t, "resolve");
    const api = new ApiClient(tokens);
    let liveRequests = 0;
    t.mock.method(globalThis, "fetch", async (url) => {
        assert.equal(String(url), TSLIVE_LIVE, "the retained live URL; no master request");
        return new Response("", { status: ++liveRequests === 1 ? 500 : 404 });
    });
    const result = await new StreamDownloader(captureHandle(TSLIVE_LIVE), api, new AccessIncidentTracker())
        .run("https://master.example.test/master.m3u8", playlistStub(), { count: 0 }, { materialized: false });
    assert.equal(result.exitReason, "playlist-not-found");
    assert.deepEqual(sleeps, [1_000]);
    assert.deepEqual(signalled, [1_000, 1_000], "one hedge timer per playlist request");
});

test("pin: LADDER retries a failed live playlist after the 5 s default", async (t) => {
    const { sleeps } = recordSleeps(t, "resolve");
    const ladder = ladderClient(t);
    ladder.parseMasterPlaylist = async () => LADDER_LIVE;
    let downloader;
    let liveRequests = 0;
    t.mock.method(globalThis, "fetch", async () => {
        if (++liveRequests === 2) downloader.abort();
        return new Response("", { status: 503 });
    });
    downloader = new StreamDownloader(captureHandle(), ladder, new AccessIncidentTracker());
    const result = await downloader.run("https://master.example.test/master.m3u8", playlistStub(), { count: 0 }, { materialized: false });
    assert.equal(result.aborted, true);
    assert.deepEqual(sleeps, [5_000, 5_000]);
});

test("pin: an FMP4 429 on the live playlist re-polls after 2 s without variant recovery", async (t) => {
    const { sleeps } = recordSleeps(t, "resolve");
    const fmp4 = new ScClient();
    fmp4.parseMasterPlaylist = async () => FMP4_LIVE;
    let recoveries = 0;
    fmp4.recoverVariant = async () => { recoveries++; return null; };
    // Access diagnostics probe other URLs in the background; none here.
    fmp4.diagnoseAccessFailure = undefined;
    let downloader;
    let liveRequests = 0;
    t.mock.method(globalThis, "fetch", async (url) => {
        assert.equal(String(url), FMP4_LIVE);
        if (++liveRequests === 2) downloader.abort();
        return new Response("", { status: 429 });
    });
    downloader = new StreamDownloader(captureHandle(), fmp4, new AccessIncidentTracker());
    const result = await downloader.run("https://master.example.test/master.m3u8", playlistStub(), { count: 0 }, { materialized: false });
    assert.equal(result.aborted, true);
    assert.deepEqual(sleeps, [2_000, 2_000]);
    assert.equal(recoveries, 0);
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

test("pin: edge naming: b-hls-NN for FMP4 URLs, none for TsLive and LADDER URLs", () => {
    const edgeOf = (url) => {
        const manager = new PlaylistManager({}, "synthetic");
        manager.setEdge(url);
        return manager.timeline.edge;
    };
    assert.equal(edgeOf(FMP4_LIVE), "b-hls-08");
    assert.equal(edgeOf("https://cdn.fmp4-live.example/b-hls-123/9001/9001.m3u8"), "b-hls-123");
    assert.equal(edgeOf(TSLIVE_LIVE), null);
    assert.equal(edgeOf(LADDER_LIVE), null);
    assert.equal(edgeOf("https://example.test/b-hls-08.m3u8"), null, "only a whole path segment counts");
    // A later URL without an edge keeps the earlier one.
    const manager = new PlaylistManager({}, "synthetic");
    manager.setEdge(FMP4_LIVE);
    manager.setEdge(TSLIVE_LIVE);
    assert.equal(manager.timeline.edge, "b-hls-08");
});

test("pin: the generic loop switches edges (PDT dedup) only for b-hls-NN recovery URLs", async (t) => {
    recordSleeps(t, "resolve");
    const run = async (initialUrl, recoveredUrl) => {
        const switches = [];
        const playlist = new PlaylistManager({}, "synthetic");
        playlist.onEdgeSwitch = (oldEdge, newEdge) => switches.push([oldEdge, newEdge]);
        let fetches = 0;
        const session = {
            async fetchPlaylist(url) {
                if (++fetches === 2) throw new PlaylistNotFoundError(url);
                return null;
            },
            getLastPlaylistFailure: () => ({ kind: "http", status: 503 }),
        };
        const provider = {
            providerName: "fmp4",
            parseMasterPlaylist: async () => initialUrl,
            createDownloadSession: () => session,
            recoverVariant: async () => recoveredUrl,
        };
        const handle = captureHandle();
        await new StreamDownloader(handle, provider, new AccessIncidentTracker())
            .run(handle.masterPlaylistUrl, playlist, { count: 0 }, { materialized: false });
        return { switches, edge: playlist.timeline.edge, liveUrl: handle.state.liveUrl };
    };
    const otherEdge = FMP4_LIVE.replace("b-hls-08", "b-hls-11");
    assert.deepEqual(await run(FMP4_LIVE, otherEdge), { switches: [["b-hls-08", "b-hls-11"]], edge: "b-hls-11", liveUrl: otherEdge });
    const sameEdge = FMP4_LIVE.replace("9001_720p", "9001_480p");
    assert.deepEqual(await run(FMP4_LIVE, sameEdge), { switches: [], edge: "b-hls-08", liveUrl: sameEdge });
    const tsliveOther = TSLIVE_LIVE.replace("high", "low");
    assert.deepEqual(await run(TSLIVE_LIVE, tsliveOther), { switches: [], edge: null, liveUrl: tsliveOther });
    const ladderOther = LADDER_LIVE.replace("synthetic", "other");
    assert.deepEqual(await run(LADDER_LIVE, ladderOther), { switches: [], edge: null, liveUrl: ladderOther });
});

test("pin: the quality check's 'no change' ignores the query and the cdnhost TLD only", async () => {
    const check = async (current, better) => {
        const provider = { providerName: "fmp4", parseMasterPlaylist: async () => better };
        return await new StreamDownloader(captureHandle(), provider, new AccessIncidentTracker())
            .checkForQualityUpgrade("synthetic_alias", "https://master.example.test/master.m3u8", current);
    };
    const scPath = "b-hls-08/9001/9001_720p.m3u8";
    for (const tld of ["org", "com", "net"]) {
        assert.equal(await check(`https://cdn.fmp4-live.example/${scPath}?pkey=a`, `https://media-hls.cdnhost.${tld}/${scPath}?pkey=b`), null);
    }
    const otherEdge = `https://cdn.fmp4-live.example/b-hls-11/9001/9001_720p.m3u8`;
    assert.equal(await check(`https://cdn.fmp4-live.example/${scPath}`, otherEdge), otherEdge, "another edge is a change");
    const otherVariant = `https://cdn.fmp4-live.example/b-hls-08/9001/9001_480p.m3u8`;
    assert.equal(await check(`https://cdn.fmp4-live.example/${scPath}`, otherVariant), otherVariant);
    const otherHost = `https://media-hls.cdnalt.com/${scPath}`;
    assert.equal(await check(`https://media-hls.cdnalt.org/${scPath}`, otherHost), otherHost, "only cdnhost TLDs fold");
    assert.equal(await check(TSLIVE_LIVE, TSLIVE_LIVE.replace("token=synthetic", "token=rotated")), null);
    assert.equal(await check(TSLIVE_LIVE, null), null, "an unavailable master is no change");
});
