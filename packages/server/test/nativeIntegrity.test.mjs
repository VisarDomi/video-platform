import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fixturePart, assemble, frameIds } from "../../pipeline/test/helpers/mediaFixture.mjs";
import { finalizeMediaIntegrity, MEDIA_INTEGRITY_VALIDATOR_REVISION } from "../dist/services/hls/mediaIntegrityFinalizer.js";
import { repairFailedMediaIntegrity } from "../dist/services/hls/failedIntegrityRepair.js";
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
    assert.equal(await readFile(playlist, "utf8"), original);
    assert.equal((await readdir(root)).filter(name => name.endsWith(".mp4")).length, 2, "only original init maps exist");
});

test("a missing initialization file blocks finalization without attributing healthy fragments", async t => {
    const root = await temporary(t);
    const parts = [await fixturePart(root, "a", { fmp4: true }), await fixturePart(root, "b", { fmp4: true })];
    const playlist = await assemble(root, parts);
    const original = await readFile(playlist, "utf8");
    const before = await readFile(path.join(root, "part-0.ts"));
    await rm(path.join(root, "part-0.mp4"));
    const result = await processFinalizedRecording(root, { checkpointStore: await ledger(t, root) });
    assert.equal(result.report.status, "failed");
    assert.deepEqual(result.report.invalidSegments, []);
    assert.match(result.report.error, /ENOENT/);
    assert.equal(await readFile(playlist, "utf8"), original);
    assert.deepEqual(await readFile(path.join(root, "part-0.ts")), before);
});

test("unavailable decoders cannot authorize discarding an entire MPEG-TS recording", async t => {
    const root = await temporary(t), original = await dummyRecording(root);
    const result = await finalizeMediaIntegrity(root, { validateMedia: async () => ({
        valid: false, exitCode: 1, stderr: "Decoding requested, but no decoder found for: av1",
    }) });
    assert.equal(result.report.status, "failed");
    assert.deepEqual(result.report.invalidSegments, []);
    assert.match(result.report.error, /blocked/);
    assert.equal(await readFile(path.join(root, "playlist.m3u8"), "utf8"), original);
});

test("consecutive damaged fMP4 fragments are repaired without a percentage cap; retained media stays byte-identical", async t => {
    const root = await temporary(t);
    const parts = [];
    for (let i = 0; i < 5; i++) parts.push(await fixturePart(root, `p${i}`, { fmp4: true, frames: 3, offset: i * 35 }));
    const playlist = await assemble(root, parts, [0.3, 4, 4, 4, 0.3]);
    // Same-map, contiguous cluster. Three damaged fragments outweigh the
    // good content; this must not force a percentage-based review.
    const content = (await readFile(playlist, "utf8")).replace(/#EXT-X-DISCONTINUITY\n/g, "")
        .replace(/#EXT-X-MAP:URI="part-[1-4]\.mp4"\n/g, "");
    await writeFile(playlist, content);
    for (const i of [1, 2, 3]) await writeFile(path.join(root, `part-${i}.ts`), Buffer.alloc(32));
    const before = await readFile(path.join(root, "part-4.ts"));
    const failed = await finalizeMediaIntegrity(root);
    assert.equal(failed.report.status, "failed");
    assert.deepEqual(failed.report.invalidSegments.map(segment => segment.name), ["part-1.ts", "part-2.ts", "part-3.ts"]);
    assert.equal(failed.report.detectedInvalidSegments.length, 3);
    const trash = path.join(root, "trash"); await mkdir(trash);
    const repaired = await repairFailedMediaIntegrity(root, failed.report, {
        checkpointStore: await ledger(t, root),
        dropFile: file => rename(file, path.join(trash, path.basename(file))),
    });
    assert.equal(repaired.finalReport.status, "ready");
    assert.equal(repaired.finalReport.segmentCount, 2);
    assert.deepEqual(await readFile(path.join(root, "part-4.ts")), before);
    assert.deepEqual((await readdir(trash)).sort(), ["part-1.ts", "part-2.ts", "part-3.ts"]);
    assert((await frameIds(parts[0].input)).length > 0);
});

test("a failing single-fragment native epoch can be dropped without discarding its good neighbors", async t => {
    const root = await temporary(t);
    const parts = [];
    for (let i = 0; i < 3; i++) parts.push(await fixturePart(root, `p${i}`, { fmp4: true, offset: i * 60 }));
    const playlist = await assemble(root, parts);
    await writeFile(path.join(root, "part-1.ts"), Buffer.alloc(32));
    const report = (await finalizeMediaIntegrity(root)).report;
    assert.deepEqual(report.invalidSegments.map(item => item.name), ["part-1.ts"]);
    assert.equal(report.nativeRunResults.filter(run => run.valid).length, 2);
    const trash = path.join(root, "trash"); await mkdir(trash);
    const repaired = await repairFailedMediaIntegrity(root, report, { dropFile: file => rename(file, path.join(trash, path.basename(file))) });
    assert.equal(repaired.finalReport.status, "ready");
    assert.equal((await readFile(playlist, "utf8")).includes("part-1.ts"), false);
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

test("failed candidate verification preserves the original playlist and every media file", async t => {
    const root = await temporary(t), original = await dummyRecording(root);
    const checkpointStore = await ledger(t, root);
    await assert.rejects(repairFailedMediaIntegrity(root, failedReport(root), {
        checkpointStore, validateCandidate: async () => false,
        dropFile: async () => assert.fail("no deletion before candidate verification"),
    }), /originals.*preserved/);
    assert.equal(await readFile(path.join(root, "playlist.m3u8"), "utf8"), original);
    assert.equal((await stat(path.join(root, "1.ts"))).isFile(), true);
    assert.equal(checkpointStore.readRepair(root).phase, "planned");
});

test("interrupted published repair resumes BEFORE ready-cache or unreferenced-file cleanup", async t => {
    const root = await temporary(t); await dummyRecording(root);
    const checkpointStore = await ledger(t, root);
    const ready = { ...failedReport(root), status: "ready", segmentCount: 2, initialPlaylistValid: true, invalidSegments: [] };
    await assert.rejects(repairFailedMediaIntegrity(root, failedReport(root), {
        checkpointStore, validateCandidate: async () => true, repairPlaylist: async () => {},
        revalidate: async () => ({ kind: "processed", report: ready }),
        dropFile: async () => { throw new Error("simulated power loss at trash boundary"); },
    }), /power loss/);
    assert.equal(checkpointStore.readRepair(root).phase, "published");
    assert.equal(checkpointStore.read(root, playlistFingerprint(await readFile(path.join(root, "playlist.m3u8"), "utf8"))), null);
    // Persisted ready evidence must not bypass the unfinished file movement.
    checkpointStore.write(root, playlistFingerprint(await readFile(path.join(root, "playlist.m3u8"), "utf8")), ready);
    const trash = path.join(root, "trash"); await mkdir(trash);
    const repaired = await repairFailedMediaIntegrity(root, failedReport(root), {
        checkpointStore, validateCandidate: async () => assert.fail("verified candidate is not rescanned"),
        repairPlaylist: async () => {}, revalidate: async () => ({ kind: "processed", report: ready }),
        dropFile: file => rename(file, path.join(trash, path.basename(file))),
    });
    assert.equal(repaired.finalReport.status, "ready");
    assert.equal(checkpointStore.readRepair(root), null);
    const cached = await processFinalizedRecording(root, { checkpointStore }, {
        cleanup: async () => assert.fail("ready source must not be rescanned"),
    });
    assert.equal(cached.kind, "already-processed");
});

test("all-bad fMP4 media becomes explicitly empty, preserving recoverable discarded files", async t => {
    const root = await temporary(t);
    const parts = [await fixturePart(root, "a", { fmp4: true }), await fixturePart(root, "b", { fmp4: true })];
    await assemble(root, parts);
    for (const name of ["part-0.ts", "part-1.ts"]) await writeFile(path.join(root, name), Buffer.alloc(32));
    const failed = await finalizeMediaIntegrity(root);
    assert.equal(failed.report.invalidSegments.length, 2);
    const trash = path.join(root, "trash"); await mkdir(trash);
    const repaired = await repairFailedMediaIntegrity(root, failed.report, { dropFile: file => rename(file, path.join(trash, path.basename(file))) });
    assert.equal(repaired.finalReport.status, "empty");
    assert.equal(repaired.finalReport.segmentCount, 0);
    assert.equal((await readdir(trash)).length, 2);
});

for (const phase of ["planned", "verified", "published"]) {
    test(`actual SIGKILL at the durable ${phase} boundary resumes the repair safely`, async t => {
        const root = await temporary(t), original = await dummyRecording(root);
        const databasePath = path.join(root, "finalization.sqlite");
        const report = failedReport(root);
        const checkpointModule = new URL("../dist/services/hls/finalizationCheckpointStore.js", import.meta.url).href;
        const repairModule = new URL("../dist/services/hls/failedIntegrityRepair.js", import.meta.url).href;
        const source = `
            import {FinalizationCheckpointStore} from ${JSON.stringify(checkpointModule)};
            import {repairFailedMediaIntegrity} from ${JSON.stringify(repairModule)};
            const store = new FinalizationCheckpointStore(${JSON.stringify(databasePath)});
            const write = store.writeRepair.bind(store);
            store.writeRepair = (recording, plan) => {
                write(recording, plan);
                if (plan.phase === ${JSON.stringify(phase)}) {
                    process.stdout.write('saved-boundary'); process.kill(process.pid, 'SIGSTOP');
                }
            };
            const report = ${JSON.stringify(report)};
            await repairFailedMediaIntegrity(${JSON.stringify(root)}, report, {checkpointStore:store,
                validateCandidate:async()=>true,repairPlaylist:async()=>{},
                revalidate:async()=>({kind:'processed',report:{...report,status:'ready',invalidSegments:[]}}),
                dropFile:async()=>{throw Error('must be killed before trash');}});
        `;
        await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", source]);
            let output = "", stderr = "";
            const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("kill-boundary test timed out")); }, 10000);
            child.stdout.on("data", chunk => { output += chunk; if (output.includes("saved-boundary")) child.kill("SIGKILL"); });
            child.stderr.on("data", chunk => { stderr += chunk; });
            child.once("error", reject);
            child.once("close", (_code, signal) => {
                clearTimeout(timer);
                if (signal === "SIGKILL" && output.includes("saved-boundary")) resolve(); else reject(Error(stderr));
            });
        });
        const checkpointStore = await ledger(t, root);
        assert.equal(checkpointStore.readRepair(root).phase, phase);
        assert.equal((await stat(path.join(root, "1.ts"))).isFile(), true);
        assert.equal(await readFile(path.join(root, "playlist.m3u8"), "utf8") === original, phase !== "published");
        const trash = path.join(root, "trash"); await mkdir(trash);
        const ready = { ...report, status: "ready", segmentCount: 2, initialPlaylistValid: true, invalidSegments: [] };
        const result = await processFinalizedRecording(root, { checkpointStore }, {
            cleanup: async () => assert.fail("unfinished repair owns excluded files"),
            repairFailed: (target, failed) => repairFailedMediaIntegrity(target, failed, {
                checkpointStore, validateCandidate: async () => true, repairPlaylist: async () => {},
                revalidate: async () => ({ kind: "processed", report: ready }),
                dropFile: file => rename(file, path.join(trash, path.basename(file))),
            }),
        });
        assert.equal(result.report.status, "ready");
        assert.equal(checkpointStore.readRepair(root), null);
        assert.deepEqual(await readdir(trash), ["1.ts"]);
    });
}

test("empty captures have an explicit disposition and never invoke ffmpeg", async t => {
    const root = await temporary(t);
    await writeFile(path.join(root, "playlist.m3u8"), "#EXTM3U\n#EXT-X-ENDLIST\n");
    const result = await finalizeMediaIntegrity(root, { validateMedia: async () => assert.fail("empty is not decodable media") });
    assert.equal(result.report.status, "empty");
    assert.match(result.report.error, /empty capture/);
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
    assert.equal(result.report.status, "failed");
    assert.deepEqual(individuallyDecoded, ["1.ts"]);
    assert.deepEqual(result.report.invalidSegments.map(item => item.name), ["1.ts"]);
});
