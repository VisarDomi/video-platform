import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { PipelineOrchestrator } from "../dist/scheduler/orchestrator.js";
import { createDefaultStages } from "../dist/stages/defaultStages.js";
import { validateArtifact } from "../dist/stages/validateArtifact.js";
import { isCounterclockwiseArtifact, productionArtifactSuffix } from "../dist/stages/artifactNaming.js";
import { composeUploadMetadata, uploadLookupIdentity } from "../dist/metadata/composeUploadMetadata.js";

const exec = promisify(execFile);

async function temporary(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-shape-split-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

// TS segments of the given sizes; EXTINF claims `seconds` so short media can
// stand for long pieces (planning reads the playlist durations).
async function recording(root, entries) {
    const source = path.join(root, "2026-02-01 120000 shapes");
    await mkdir(source, { recursive: true });
    const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:100"];
    for (const [index, [size, seconds]] of entries.entries()) {
        const name = `${index}.ts`;
        await exec("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=10`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", "0.4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "mpegts",
            path.join(source, name)]);
        if (index) lines.push("#EXT-X-DISCONTINUITY");
        lines.push(`#EXTINF:${seconds},`, name);
    }
    lines.push("#EXT-X-ENDLIST", "");
    const playlistPath = path.join(source, "playlist.m3u8");
    await writeFile(playlistPath, lines.join("\n"));
    return { source, playlistPath };
}

async function ledger(t, root, source, playlistPath) {
    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const recorded = database.discover({ provider: "tango", sourceKind: "edited", sourcePath: source, playlistPath,
        sourceFingerprint: "fingerprint", durationSeconds: 200 });
    return { database, recorded };
}

test("several shapes become one validated artifact each; the short piece is recorded for a person", async (t) => {
    const root = await temporary(t);
    const { source, playlistPath } = await recording(root, [["1280x720", 70], ["720x1280", 65], ["640x480", 10]]);
    const { database, recorded } = await ledger(t, root, source, playlistPath);
    const staging = path.join(root, "staging");
    const result = await new PipelineOrchestrator(database, createDefaultStages(staging), "shape-test").processRecording(recorded.id);
    assert.equal(result.state, "artifact_valid");
    const primary = database.getArtifact(recorded.id);
    assert.equal(database.getArtifactPart(recorded.id), "shape1");
    assert(primary.path.endsWith(".production-v5-shape1.mp4"));
    const [queued] = database.listQueuedProductionArtifacts(recorded.id);
    assert.equal(queued.part, "shape2");
    assert(queued.path.endsWith(".production-v5-shape2-ccw.mp4"), "the portrait shape is turned");
    for (const artifact of [primary, queued]) {
        const validated = await validateArtifact(artifact.path);
        assert.deepEqual([validated.videoWidth, validated.videoHeight], [1920, 1080]);
        assert.equal(validated.sha256, artifact.sha256);
    }
    const [piece] = database.listManualPieces(recorded.id);
    assert.equal(piece.part, "shape3");
    assert.deepEqual(piece.segmentIndexes, [2]);
    assert.equal(piece.durationSeconds, 10);
    assert.deepEqual(piece.sourceDimensions, ["640x480"]);
    assert.deepEqual((await readdir(staging)).sort(), [path.basename(primary.path), path.basename(queued.path)].sort(),
        "no file for the manual piece, no leftovers");
});

test("when every piece of a split is under a minute the recording is blocked for a person", async (t) => {
    const root = await temporary(t);
    const { source, playlistPath } = await recording(root, [["1280x720", 30], ["720x1280", 20]]);
    const { database, recorded } = await ledger(t, root, source, playlistPath);
    const result = await new PipelineOrchestrator(database, createDefaultStages(path.join(root, "staging")), "shape-test")
        .processRecording(recorded.id);
    assert.equal(result.state, "blocked");
    assert.match(result.blockReason, /^resolution-policy-v5: .*no piece is long enough to upload/);
    assert.deepEqual(database.listManualPieces(recorded.id).map((piece) => piece.part), ["shape1", "shape2"]);
    assert(database.hasResolutionPolicyAssessment(recorded.id, "resolution-policy-v5"));
});

test("split parts get their own public title suffix, and the lookup finds each one", () => {
    const recorded = { id: "2026-02-01 120000 shapes", provider: "tango", sourcePath: "/x/2026-02-01 120000 shapes" };
    const provenance = { recordingId: recorded.id, observedIdentifier: "shapes", status: "resolved", streamerId: "1",
        alias: "shapes", streamerUrl: "https://tango.me/1", aliasUrl: null, reason: null, updatedAt: "2026-02-01T00:00:00Z" };
    const description = { recordingId: recorded.id, artifactSha256: "a".repeat(64), promptVersion: "p", fps: 1,
        output: { title: "Title", description: "Description" }, evidencePath: "/x", createdAt: "2026-02-01T00:00:00Z" };
    assert.equal(composeUploadMetadata(recorded, description, provenance).title, "Title [2026-02-01 120000 shapes]");
    const part = composeUploadMetadata(recorded, description, provenance, "shape2").title;
    assert.equal(part, "Title [2026-02-01 120000 shapes | part 2]");
    assert.equal(uploadLookupIdentity(recorded, "shape2", part), "2026-02-01 120000 shapes | part 2");
    assert.equal(uploadLookupIdentity(recorded, "full", part), null, "part 2 is never mistaken for the whole recording");
    assert.equal(uploadLookupIdentity(recorded, "shape1", part), null);
});

test("only counterclockwise-turned production artifacts ask the descriptor to turn the picture back", () => {
    assert.equal(productionArtifactSuffix("full", false), "production-v5");
    assert.equal(productionArtifactSuffix("full", true), "production-v5-ccw");
    assert.equal(productionArtifactSuffix("shape3", true), "production-v5-shape3-ccw");
    assert(isCounterclockwiseArtifact("/a/2026-02-01 120000 shapes.production-v5-ccw.mp4"));
    assert(isCounterclockwiseArtifact("/a/2026-02-01 120000 shapes.production-v5-shape2-ccw.mp4"));
    assert(!isCounterclockwiseArtifact("/a/2026-02-01 120000 shapes.production-v5.mp4"));
    assert(!isCounterclockwiseArtifact("/a/2026-02-01 120000 shapes.production-upscale1080p.mp4"));
});
