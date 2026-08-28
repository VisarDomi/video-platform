import assert from "node:assert/strict";
import test from "node:test";

import { ScClient } from "../dist/services/sc/api/scClient.js";

const masterDocument = [
    "#EXTM3U",
    "#EXT-X-MOUFLON:PSCH:v2:test-key",
    '#EXT-X-STREAM-INF:BANDWIDTH=5800000,RESOLUTION=1920x1080,NAME="source"',
    "https://media-hls.doppiocdn.org/b-hls-08/123/123.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720,NAME="720p"',
    "https://media-hls.doppiocdn.org/b-hls-08/123/123_720p.m3u8",
    "",
].join("\n");

test("Stripchat target refresh uses the room-ID cam endpoint", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });

    let requestedUrl = "";
    globalThis.fetch = async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({
            cam: {
                streamName: "stream-167036615",
                isCamAvailable: true,
                isCamActive: true,
            },
            user: {
                user: {
                    id: 167036615,
                    username: "momo_love_",
                    statusChangedAt: "2026-08-27T11:14:39Z",
                },
            },
        }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    const client = new ScClient();
    assert.deepEqual(await client.refreshTarget("167036615", "old_alias"), {
        roomId: "167036615",
        username: "momo_love_",
        streamName: "stream-167036615",
        statusChangedAt: "2026-08-27T111439Z",
    });
    assert.equal(
        requestedUrl,
        "https://stripchat.com/api/front/v2/models/167036615/cam",
    );
});

test("Stripchat target refresh rejects a mismatched room identity", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(JSON.stringify({
        cam: { streamName: "wrong", isCamAvailable: true, isCamActive: true },
        user: { user: { id: 999, username: "wrong_model" } },
    }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });

    const client = new ScClient();
    assert.equal(await client.refreshTarget("167036615", "momo_love_"), null);
});

test("Stripchat source remains the described master-best variant", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(masterDocument, { status: 200 });

    const client = new ScClient();
    await client.init();
    const selected = await client.parseMasterPlaylist(
        "https://edge-hls.doppiocdn.org/hls/123/master/123_auto.m3u8",
    );
    assert.ok(selected);
    assert.match(selected, /\/123\.m3u8\?/);
    assert.deepEqual(client.describeVariant(selected), {
        name: "source",
        resolution: "1920x1080",
        bandwidth: 5_800_000,
        isMasterBest: true,
    });
});

test("access evidence distinguishes paid denial from a quality decision", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.includes("stripchat.com/api/front/v2/models/123/cam")) {
            return new Response(JSON.stringify({
                user: { user: { id: 123, username: "alias", status: "groupShow", isLive: true, statusChangedAt: "2026-08-28T16:20:07Z" } },
                cam: { isCamActive: true, isCamAvailable: false, streamName: "123" },
            }), { status: 200 });
        }
        if (value.includes("/master/123_auto.m3u8")) return new Response(masterDocument, { status: 200 });
        return new Response("", { status: 403 });
    };

    const client = new ScClient();
    await client.init();
    const evidence = await client.diagnoseAccessFailure({
        stage: "playlist",
        streamerId: "123",
        alias: "alias",
        recordingId: "recording",
        masterUrl: "https://edge-hls.doppiocdn.org/hls/123/master/123_auto.m3u8",
        liveUrl: "https://media-hls.doppiocdn.org/b-hls-08/123/123.m3u8?psch=v2&pkey=test",
        failure: { kind: "http", status: 403 },
    });

    assert.equal(evidence.providerState.status, "groupShow");
    assert.equal(evidence.providerState.isLive, true);
    assert.equal(evidence.providerState.camAvailable, false);
    assert.equal(evidence.selected.resolution, "1920x1080");
    assert.equal(evidence.nextLower.resolution, "1280x720");
    assert.equal(evidence.probes.selectedPrimary.status, 403);
    assert.equal(evidence.probes.selectedAlternateTld.status, 403);
    assert.equal(evidence.probes.nextLower.status, 403);
    assert.equal(evidence.behavior, "observe-only");
});

test("access evidence can prove public source denial with a working lower variant", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.includes("stripchat.com/api/front/v2/models/123/cam")) {
            return new Response(JSON.stringify({
                user: { user: { id: 123, username: "alias", status: "public", isLive: true, statusChangedAt: "2026-08-28T17:00:00Z" } },
                cam: { isCamActive: true, isCamAvailable: true, streamName: "123" },
            }), { status: 200 });
        }
        if (value.includes("/master/123_auto.m3u8")) return new Response(masterDocument, { status: 200 });
        if (value.includes("123_720p.m3u8")) return new Response("#EXTM3U\n", { status: 200 });
        return new Response("", { status: 403 });
    };

    const client = new ScClient();
    await client.init();
    const evidence = await client.diagnoseAccessFailure({
        stage: "playlist",
        streamerId: "123",
        alias: "alias",
        recordingId: "recording",
        masterUrl: "https://edge-hls.doppiocdn.org/hls/123/master/123_auto.m3u8",
        liveUrl: "https://media-hls.doppiocdn.org/b-hls-08/123/123.m3u8?psch=v2&pkey=test",
        failure: { kind: "http", status: 403 },
    });

    assert.equal(evidence.providerState.status, "public");
    assert.equal(evidence.probes.selectedPrimary.status, 403);
    assert.equal(evidence.probes.selectedAlternateTld.status, 403);
    assert.equal(evidence.probes.nextLower.status, 200);
    assert.equal(evidence.probes.nextLower.decryptable, true);
});
