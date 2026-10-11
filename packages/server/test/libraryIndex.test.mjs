import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderIndex, playlistDuration } from "../dist/services/video/library-index.js";

const playlist = (...durations) => "#EXTM3U\n#EXT-X-TARGETDURATION:10\n" + durations.map((d, i) => `#EXTINF:${d},\nseg${i}.ts\n`).join("") + "#EXT-X-ENDLIST\n";

async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), "library-index-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dirs = { live: path.join(root, "downloaded", ".active"), original: path.join(root, "downloaded"), edited: path.join(root, "edited") };
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
    const add = async (dir, name, text) => {
        await mkdir(path.join(dir, name), { recursive: true });
        if (text !== undefined) await writeFile(path.join(dir, name, "playlist.m3u8"), text);
    };
    return { root, dirs, add, state: path.join(root, "state", "tango.json") };
}

test("playlist durations sum EXTINF values as the Go helper did", () => {
    assert.equal(playlistDuration(playlist(10, 9.5, 0.25)), 19.75);
    assert.equal(playlistDuration("#EXTINF:abc,\n#EXTINF:,\n#EXTINF:4,title\r\n"), 4);
});

test("the index lists, follows changes, long-polls and survives a restart", async (t) => {
    const { dirs, add, state } = await fixture(t);
    await add(dirs.original, "2026-01-01 100000 alice", playlist(10, 20));
    await add(dirs.edited, "2026-01-02 100000 bob", playlist(5));
    await add(dirs.live, "2026-01-03 100000 carol", playlist(4));
    await add(dirs.live, "2026-01-03 110000 dave"); // no playlist yet: not listed
    await add(dirs.original, ".pending");
    const index = new ProviderIndex("tango", dirs, state);
    t.after(() => index.stop());
    const videos = await index.videos();
    assert.deepEqual(videos.map(v => [v.filename, v.type, v.duration, v.isLive]), [
        ["2026-01-01 100000 alice", "original", 30, false],
        ["2026-01-02 100000 bob", "edited", 5, false],
        ["2026-01-03 100000 carol", "original", 0, true],
    ]);
    assert.deepEqual((await index.videos("2026-01-02")).map(v => v.filename), ["2026-01-02 100000 bob", "2026-01-03 100000 carol"]);

    const first = await index.changes(undefined, undefined);
    assert.equal(first.videos.length, 3, "A new client gets the whole list");
    assert.deepEqual((await index.changes(first.revision, "another epoch")).videos?.length, 3, "Another epoch gets the whole list");

    // Nothing new: the request waits for the next change, which arrives with only that change.
    const waiting = index.changes(first.revision, first.epoch, 5000);
    await rename(path.join(dirs.live, "2026-01-03 100000 carol"), path.join(dirs.original, "2026-01-03 100000 carol"));
    await writeFile(path.join(dirs.original, "2026-01-03 100000 carol", "playlist.m3u8"), playlist(4, 4, 4));
    await index.refresh();
    const finished = await waiting;
    assert.ok(finished.changes.some(c => c.item?.filename === "2026-01-03 100000 carol" && !c.item.isLive && c.item.duration === 12),
        "A live recording that finished is updated in place");
    assert.equal(finished.videos, undefined);

    // A save moves the folder to edited: the original goes, the edited arrives.
    await rename(path.join(dirs.original, "2026-01-01 100000 alice"), path.join(dirs.edited, "2026-01-01 100000 alice"));
    await index.refresh();
    const moved = await index.changes(finished.revision, first.epoch);
    assert.deepEqual(moved.changes.filter(c => c.removed).map(c => [c.removed.filename, c.removed.type]), [["2026-01-01 100000 alice", "original"]]);
    assert.deepEqual(moved.changes.filter(c => c.item).map(c => [c.item.filename, c.item.type]), [["2026-01-01 100000 alice", "edited"]]);
    assert.deepEqual((await index.changes(moved.revision, first.epoch, 0)).changes, [], "Up to date: no changes, no wait");

    // Saved and reloaded: the same list without reading playlists again.
    await index.stop();
    const reopened = new ProviderIndex("tango", dirs, state);
    t.after(() => reopened.stop());
    assert.deepEqual((await reopened.videos()).map(v => [v.filename, v.type, v.duration]), [
        ["2026-01-01 100000 alice", "edited", 30],
        ["2026-01-02 100000 bob", "edited", 5],
        ["2026-01-03 100000 carol", "original", 12],
    ]);
    assert.ok(reopened.currentRevision >= moved.revision, "The revision survives a restart");
});

test("folder events alone update the index", async (t) => {
    const { dirs, add, state } = await fixture(t);
    const index = new ProviderIndex("tango", dirs, state);
    t.after(() => index.stop());
    const start = await index.changes(undefined, undefined);
    assert.equal(start.videos.length, 0);
    const waiting = index.changes(start.revision, start.epoch, 5000);
    await add(dirs.original, "2026-02-01 090000 erin", playlist(7));
    const added = await waiting;
    assert.deepEqual(added.changes.map(c => c.item?.filename), ["2026-02-01 090000 erin"]);
});
