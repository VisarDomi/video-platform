import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixturePart, assemble, frameIds } from "../../pipeline/test/helpers/mediaFixture.mjs";
import { finalizeMediaIntegrity, MEDIA_INTEGRITY_VALIDATOR_REVISION } from "../dist/services/hls/mediaIntegrityFinalizer.js";
import { processFinalizedRecording } from "../dist/services/hls/finalizedRecordingProcessor.js";
import { FinalizationCheckpointStore, playlistFingerprint } from "../dist/services/hls/finalizationCheckpointStore.js";

async function temporary(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-integrity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}
async function ledger(t, root) {
    const db = new FinalizationCheckpointStore(path.join(root, "finalization.sqlite"));
    t.after(() => db.close());
    return db;
}
async function snapshot(root) {
    const names = (await readdir(root)).filter(name => name.endsWith(".ts") || name.endsWith(".mp4")).sort();
    return Object.fromEntries(await Promise.all(names.map(async name => [name, (await readFile(path.join(root, name))).toString("base64")])));
}

test("native AV1/H264 and absent/present audio validate without modifying or encoding the capture", async t => {
    const root = await temporary(t);
    const parts = [await fixturePart(root, "av1", { fmp4: true, codec: "libaom-av1", frames: 3, audio: false }),
        await fixturePart(root, "h264", { fmp4: true, offset: 70, frames: 3 })];
    const playlist = await assemble(root, parts);
    const original = await readFile(playlist, "utf8");
    const checkpointStore = await ledger(t, root);
    const result = await finalizeMediaIntegrity(root, { checkpointStore });
    assert.equal(result.report.status, "ready");
    assert.equal(result.report.deepScannedSegmentCount, 0);
    assert.equal(result.report.nativeRunResults.length, 2);
    assert.deepEqual(result.report.warnings, []);
    assert.equal(await readFile(playlist, "utf8"), original);
    assert.equal((await readdir(root)).filter(name => name.endsWith(".mp4")).length, 2, "only original init maps exist");
});

test("a missing initialization file publishes unvalidated with a warning; nothing is attributed or moved", async t => {
    const root = await temporary(t);
    const parts = [await fixturePart(root, "a", { fmp4: true }), await fixturePart(root, "b", { fmp4: true })];
    const playlist = await assemble(root, parts);
    const original = await readFile(playlist, "utf8");
    await rm(path.join(root, "part-0.mp4"));
    const before = await snapshot(root);
    const result = await processFinalizedRecording(root, { checkpointStore: await ledger(t, root) });
    assert.equal(result.report.status, "ready");
    assert.deepEqual(result.report.invalidSegments, []);
    const warning = result.report.warnings.find(item => item.kind === "validation-incomplete");
    assert.match(warning.message, /ENOENT/);
    assert.equal(await readFile(playlist, "utf8"), original);
    assert.deepEqual(await snapshot(root), before);
});

test("unavailable decoders are an environment failure: the recording stays pending and is retried", async t => {
    const root = await temporary(t), original = await dummyRecording(root);
    const checkpointStore = await ledger(t, root);
    const result = await finalizeMediaIntegrity(root, { checkpointStore, validateMedia: async () => ({
        valid: false, exitCode: 1, stderr: "Decoding requested, but no decoder found for: av1",
    }) });
    assert.equal(result.report.status, "failed");
    assert.deepEqual(result.report.invalidSegments, []);
    assert.match(result.report.error, /blocked/);
    assert.equal(await readFile(path.join(root, "playlist.m3u8"), "utf8"), original);

    // A failed (environment) checkpoint is never final.
    const retried = await finalizeMediaIntegrity(root, { checkpointStore,
        validateMedia: async () => ({ valid: true, exitCode: 0, stderr: "" }) });
    assert.equal(retried.kind, "processed");
    assert.equal(retried.report.status, "ready");
});

test("ffmpeg that cannot be started is an environment failure, not media damage", async t => {
    const root = await temporary(t); await dummyRecording(root);
    const result = await finalizeMediaIntegrity(root, { validateMedia: async () => {
        throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT", syscall: "spawn ffmpeg" });
    } });
    assert.equal(result.report.status, "failed");
    assert.match(result.report.error, /spawn ffmpeg/);
});

test("consecutive damaged fMP4 fragments are kept byte-identical and reported; the recording is ready", async t => {
    const root = await temporary(t);
    const parts = [];
    for (let i = 0; i < 5; i++) parts.push(await fixturePart(root, `p${i}`, { fmp4: true, frames: 3, offset: i * 35 }));
    const playlist = await assemble(root, parts, [0.3, 4, 4, 4, 0.3]);
    // Same-map, contiguous cluster. Three damaged fragments outweigh the good content.
    const content = (await readFile(playlist, "utf8")).replace(/#EXT-X-DISCONTINUITY\n/g, "")
        .replace(/#EXT-X-MAP:URI="part-[1-4]\.mp4"\n/g, "");
    await writeFile(playlist, content);
    for (const i of [1, 2, 3]) await writeFile(path.join(root, `part-${i}.ts`), Buffer.alloc(32));
    const before = await snapshot(root);
    const result = await finalizeMediaIntegrity(root);
    assert.equal(result.report.status, "ready");
    assert.equal(result.report.segmentCount, 5);
    assert.deepEqual(result.report.invalidSegments.map(segment => segment.name), ["part-1.ts", "part-2.ts", "part-3.ts"]);
    assert.deepEqual(result.report.warnings.find(item => item.kind === "damaged-segments").names,
        ["part-1.ts", "part-2.ts", "part-3.ts"]);
    assert.equal(await readFile(playlist, "utf8"), content);
    assert.deepEqual(await snapshot(root), before);
    assert((await frameIds(parts[0].input)).length > 0);
});

test("a failing single-fragment native epoch is reported while it and its neighbors stay in the playlist", async t => {
    const root = await temporary(t);
    const parts = [];
    for (let i = 0; i < 3; i++) parts.push(await fixturePart(root, `p${i}`, { fmp4: true, offset: i * 60 }));
    const playlist = await assemble(root, parts);
    await writeFile(path.join(root, "part-1.ts"), Buffer.alloc(32));
    const original = await readFile(playlist, "utf8");
    const report = (await finalizeMediaIntegrity(root)).report;
    assert.equal(report.status, "ready");
    assert.deepEqual(report.invalidSegments.map(item => item.name), ["part-1.ts"]);
    assert.equal(report.nativeRunResults.filter(run => run.valid).length, 2);
    assert.equal(await readFile(playlist, "utf8"), original);
});

function failedReport(root) {
    return { version: 2, validatorRevision: MEDIA_INTEGRITY_VALIDATOR_REVISION, status: "failed",
        startedAt: "2026-10-02T00:00:00Z", completedAt: "2026-10-02T00:01:00Z",
        playlistPath: path.join(root, "playlist.m3u8"), segmentCount: 3,
        initialPlaylistValid: false, initialValidationError: "corrupt decoded frame", deepScannedSegmentCount: 3,
        invalidSegments: [{ name: "1.ts", error: "corrupt decoded frame" }], error: "decode error" };
}
async function dummyRecording(root) {
    const content = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n0.ts\n#EXTINF:1,\n1.ts\n#EXTINF:1,\n2.ts\n#EXT-X-ENDLIST\n";
    await writeFile(path.join(root, "playlist.m3u8"), content);
    for (const name of ["0.ts", "1.ts", "2.ts"]) await writeFile(path.join(root, name), name);
    return content;
}

test("all-bad fMP4 media is still published with every fragment kept", async t => {
    const root = await temporary(t);
    const parts = [await fixturePart(root, "a", { fmp4: true }), await fixturePart(root, "b", { fmp4: true })];
    const playlist = await assemble(root, parts);
    for (const name of ["part-0.ts", "part-1.ts"]) await writeFile(path.join(root, name), Buffer.alloc(32));
    const original = await readFile(playlist, "utf8");
    const result = await finalizeMediaIntegrity(root);
    assert.equal(result.report.status, "ready");
    assert.equal(result.report.segmentCount, 2);
    assert.equal(result.report.invalidSegments.length, 2);
    assert.equal(await readFile(playlist, "utf8"), original);
});

test("empty captures have an explicit disposition and never invoke ffmpeg", async t => {
    const root = await temporary(t);
    await writeFile(path.join(root, "playlist.m3u8"), "#EXTM3U\n#EXT-X-ENDLIST\n");
    const result = await finalizeMediaIntegrity(root, { validateMedia: async () => assert.fail("empty is not decodable media") });
    assert.equal(result.report.status, "empty");
    assert.match(result.report.error, /empty capture/);
});

test("a playlist the validator cannot interpret is published unvalidated", async t => {
    const root = await temporary(t);
    await writeFile(path.join(root, "playlist.m3u8"), "#EXTM3U\n#EXTINF:0,\n0.ts\n#EXT-X-ENDLIST\n");
    await writeFile(path.join(root, "0.ts"), "media");
    const result = await finalizeMediaIntegrity(root, { validateMedia: async () => assert.fail("not decodable as listed") });
    assert.equal(result.report.status, "ready");
    assert.equal(result.report.segmentCount, 1);
    assert.equal(result.report.warnings[0].kind, "validation-incomplete");
});

test("native-run validation resumes after the saved completed run without decoding it again", async t => {
    const root = await temporary(t);
    const content = (await dummyRecording(root)).replace("#EXTINF:1,\n1.ts", "#EXT-X-DISCONTINUITY\n#EXTINF:1,\n1.ts");
    await writeFile(path.join(root, "playlist.m3u8"), content);
    const checkpointStore = await ledger(t, root);
    checkpointStore.write(root, playlistFingerprint(content), { ...failedReport(root), status: "processing", completedAt: null,
        initialPlaylistValid: null, initialValidationError: null, invalidSegments: [], deepScannedSegmentCount: 0,
        nativeRunResults: [{ firstIndex: 0, lastIndex: 0, valid: true, error: null }] });
    const inputs = [];
    const result = await finalizeMediaIntegrity(root, { checkpointStore, validateMedia: async input => {
        inputs.push(await readFile(input, "utf8")); return { valid: true, exitCode: 0, stderr: "" };
    } });
    assert.equal(result.report.status, "ready");
    assert.equal(inputs.length, 1);
    assert(!inputs[0].includes("/0.ts"));
});

test("MPEG-TS damage attribution does not decode segments from already-valid native runs again", async t => {
    const root = await temporary(t);
    const content = (await dummyRecording(root)).replace("#EXTINF:1,\n1.ts", "#EXT-X-DISCONTINUITY\n#EXTINF:1,\n1.ts")
        .replace("#EXTINF:1,\n2.ts", "#EXT-X-DISCONTINUITY\n#EXTINF:1,\n2.ts");
    await writeFile(path.join(root, "playlist.m3u8"), content);
    const individuallyDecoded = [];
    const result = await finalizeMediaIntegrity(root, { validateMedia: async input => {
        const playlist = input.endsWith(".m3u8") ? await readFile(input, "utf8") : "";
        if (!playlist) individuallyDecoded.push(path.basename(input));
        const bad = playlist ? playlist.includes("/1.ts") : path.basename(input) === "1.ts";
        return { valid: !bad, exitCode: bad ? 1 : 0, stderr: bad ? "corrupt decoded frame" : "" };
    } });
    assert.equal(result.report.status, "ready");
    assert.deepEqual(individuallyDecoded, ["1.ts"]);
    assert.deepEqual(result.report.invalidSegments.map(item => item.name), ["1.ts"]);
    assert.equal(await readFile(path.join(root, "playlist.m3u8"), "utf8"), content);
});
