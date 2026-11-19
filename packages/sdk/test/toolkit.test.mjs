import assert from "node:assert/strict";
import test from "node:test";
import {
    CDN_FETCH_TIMEOUT_MS,
    formatTimestampForPath,
    normalizeRecordingId,
    PlaylistNotFoundError,
    requestSignal,
    resolveSegmentUrl,
    targetKey,
    targetMembershipIdentifiers,
} from "../dist/index.js";

test("the shared request timeout stays 30 s", () => {
    assert.equal(CDN_FETCH_TIMEOUT_MS, 30_000);
});

test("a request signal aborts with the caller's signal or on its own timeout", async () => {
    const caller = new AbortController();
    const signal = requestSignal(60_000, caller.signal);
    assert.equal(signal.aborted, false);
    caller.abort();
    assert.equal(signal.aborted, true);
    const timed = requestSignal(1);
    // The timeout's timer does not keep the process alive; this one does.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(timed.aborted, true);
    assert.equal(timed.reason.name, "TimeoutError");
});

test("playlist lines resolve against the playlist URL; other text is kept", () => {
    assert.equal(resolveSegmentUrl("https://cdn.example.test/a/live.m3u8?x=1", "seg_1.ts"), "https://cdn.example.test/a/seg_1.ts");
    assert.equal(resolveSegmentUrl("https://cdn.example.test/a/live.m3u8", "/b/seg.ts"), "https://cdn.example.test/b/seg.ts");
    assert.equal(resolveSegmentUrl("not a url", "seg.ts"), "seg.ts");
});

test("recording identities: ISO UTC time stamps are stored compactly, others unchanged", () => {
    assert.equal(normalizeRecordingId("2026-08-27T11:14:39Z"), "2026-08-27T111439Z");
    assert.equal(normalizeRecordingId("2026-08-27T11:14:39.250Z"), "2026-08-27T111439Z");
    assert.equal(normalizeRecordingId("2026-08-27T111439Z"), "2026-08-27T111439Z");
    assert.equal(normalizeRecordingId("1234567"), "1234567");
    assert.equal(formatTimestampForPath(new Date(2026, 2, 4, 5, 6, 7)), "2026-03-04 050607");
    assert.throws(() => formatTimestampForPath(new Date(NaN)), /invalid timestamp/);
});

test("a missing playlist is recognized by brand, also from another copy of the class", () => {
    const error = new PlaylistNotFoundError("https://cdn.example.test/live.m3u8");
    assert.ok(error instanceof PlaylistNotFoundError);
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Playlist returned HTTP 404: https://cdn.example.test/live.m3u8");
    assert.equal(error.url, "https://cdn.example.test/live.m3u8");
    // A plug-in built against another copy of the SDK throws its own class.
    const brand = Symbol.for("video-platform.sdk.PlaylistNotFoundError");
    const foreign = Object.defineProperty(new Error("x"), brand, { value: true });
    assert.ok(foreign instanceof PlaylistNotFoundError);
    assert.ok(!(new Error("x") instanceof PlaylistNotFoundError));
    assert.ok(!(null instanceof PlaylistNotFoundError));
});

// Moved from shared/test/pins.test.mjs with the same assertion (the helper moved here so
// the core and the catalogs share it).
test("pin: the names a listed target answers to: ID, label, former names, trimmed, unique", () => {
    const fmp4 = { id: "20000002", label: "synthetic_room" };
    assert.deepEqual(targetMembershipIdentifiers(fmp4, [" old_room ", "synthetic_room", ""]),
        ["20000002", "synthetic_room", "old_room"]);
    assert.deepEqual(targetMembershipIdentifiers(fmp4), ["20000002", "synthetic_room"]);
});

test("a list knows an entry by its ID, or by its label while it has none", () => {
    assert.equal(targetKey({ id: "20000002", label: "synthetic_room" }), "20000002");
    assert.equal(targetKey({ id: "", label: "unresolved" }), "unresolved");
});
