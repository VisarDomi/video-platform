import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { findArtifactCacheCandidates, reuseCachedArtifact, artifactRecipeReason } from "../dist/stages/artifactCache.js";
import { createDefaultStages } from "../dist/stages/defaultStages.js";
import { artifactSha256 } from "../dist/stages/validateArtifact.js";
import { inspectRecording } from "../dist/discovery/inspectRecording.js";
import { PipelineOrchestrator } from "../dist/scheduler/orchestrator.js";
import { UploadCoordinator } from "../dist/upload/uploadCoordinator.js";
import { descriptorConfig } from "../../descriptor/dist/config.js";
import { chooseVideoFps, probeDuration } from "../../descriptor/dist/media.js";
import { fixturePart, assemble } from "./helpers/mediaFixture.mjs";

async function fixture(t, generation = "production-v5") {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-artifact-cache-"));
    const config = { databasePath: path.join(root, "pipeline.sqlite"), artifactsRoot: path.join(root, "artifacts") };
    const database = new PipelineDatabase(config.databasePath);
    t.after(async () => { database.close(); await fs.rm(root, { recursive: true, force: true }); });
    const raw = new DatabaseSync(config.databasePath);
    raw.prepare("UPDATE production_version SET version = ?").run(generation);
    raw.close();
    const sourcePath = path.join(root, "2026-01-01 123456 cache-test");
    const recording = database.discover({ provider: "tango", sourceKind: "edited", sourcePath,
        playlistPath: path.join(sourcePath, "playlist.m3u8"), sourceFingerprint: "source-v1", durationSeconds: 1 });
    const oldRoot = path.join(config.artifactsRoot, generation);
    const newRoot = path.join(config.artifactsRoot, "production-v6");
    await fs.mkdir(oldRoot, { recursive: true });
    return { root, config, database, recording, oldRoot, newRoot };
}

async function seed(f, reason = artifactRecipeReason("approved recipe"), suffix = ".production-v5") {
    const artifactPath = path.join(f.oldRoot, `${f.recording.id}${suffix}.mp4`);
    const bytes = Buffer.from("synthetic validated artifact bytes");
    await fs.writeFile(artifactPath, bytes);
    f.database.saveRemuxOutput(f.recording.id, artifactPath, new Date(), reason);
    f.database.saveArtifact(f.recording.id, { path: artifactPath, sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), validatedAt: new Date().toISOString() });
    return artifactPath;
}

async function rollover(f, target = "production-v6") {
    const directory = path.join(f.root, "history", f.database.getProductionVersion());
    await fs.mkdir(directory, { recursive: true });
    f.database.snapshotTo(path.join(directory, "snapshot.sqlite"));
    f.database.commitProductionRollover(target);
    return f.database.discover(f.recording);
}

for (const generation of ["production-v4", "production-v5"]) {
    test(`${generation} validated media survives rollover as a byte-identical independent generation path`, async (t) => {
        const f = await fixture(t, generation);
        const oldPath = await seed(f);
        const current = await rollover(f);
        const hit = await reuseCachedArtifact(current, f.newRoot, f.config);
        assert.equal(path.dirname(hit.path), f.newRoot);
        assert.match(hit.eventReason, /resolution-policy-v5: \[artifact-recipe-v2\] artifact cache hit/);
        assert.equal(await artifactSha256(hit.path), await artifactSha256(oldPath));
        assert.equal((await fs.stat(hit.path)).ino, (await fs.stat(oldPath)).ino, "same-filesystem hit does not duplicate storage");
        assert.equal(f.database.getArtifact(current.id), null, "no old pipeline state imported");
        assert.equal(f.database.getDescription(current.id), null);
        assert.equal(f.database.getUploadIdentity(current.id), null);
        await fs.unlink(hit.path);
        assert((await fs.stat(oldPath)).isFile(), "removing the new generation link preserves old comparisons");
    });
}

test("whole-recording artifacts, turned or not, reuse without changing their filenames", async (t) => {
    for (const suffix of [".production-v5", ".production-v5-ccw"]) {
        await t.test(suffix, async (t) => {
            const f = await fixture(t);
            const oldPath = await seed(f, artifactRecipeReason("convert"), suffix);
            const hit = await reuseCachedArtifact(f.recording, f.newRoot, f.config);
            assert.equal(path.basename(hit.path), path.basename(oldPath));
            assert.equal(await artifactSha256(hit.path), await artifactSha256(oldPath));
        });
    }
});

test("reuse requires the current recipe tag, never a generation number or an older recipe", async (t) => {
    for (const generation of ["production-v3", "production-v6"]) {
        await t.test(generation, async (t) => {
            const f = await fixture(t, generation);
            await seed(f, "resolution-policy-v4: approved original v4/v5 recipe");
            assert.equal(await reuseCachedArtifact(f.recording, f.newRoot, f.config), null);
            if (generation === "production-v6") {
                const raw = new DatabaseSync(f.config.databasePath);
                raw.prepare("UPDATE state_events SET reason = ? WHERE to_state = 'remuxed'")
                    .run(artifactRecipeReason("approved source processing"));
                raw.close();
                const current = await rollover(f, "production-v7");
                const hit = await reuseCachedArtifact(current, path.join(f.config.artifactsRoot, "production-v7"), f.config);
                assert(hit, "cache is independent of upload generation");
            }
        });
    }
});

test("cache refuses changed source/provider/path, old policy, different recipe, and post-validation source mutation", async (t) => {
    const f = await fixture(t);
    await seed(f);
    for (const change of [{ sourceFingerprint: "source-v2" }, { provider: "sc" }, { sourcePath: f.root },
        { playlistPath: path.join(f.root, "other.m3u8") }]) {
        assert.equal(await reuseCachedArtifact({ ...f.recording, ...change }, f.newRoot, f.config), null);
    }
    const raw = new DatabaseSync(f.config.databasePath);
    try {
        for (const reason of ["resolution-policy-v3: old target", "resolution-policy-v4: [artifact-recipe-v2] other policy",
            "resolution-policy-v5: [artifact-recipe-v1] older recipe"]) {
            raw.prepare("UPDATE state_events SET reason = ? WHERE to_state = 'remuxed'").run(reason);
            assert.equal(await reuseCachedArtifact(f.recording, f.newRoot, f.config), null);
        }
        raw.prepare("UPDATE state_events SET reason = ? WHERE to_state = 'remuxed'").run(artifactRecipeReason("new encode"));
    } finally { raw.close(); }
    assert.equal((await findArtifactCacheCandidates(f.recording, f.config)).length, 1);
    const changed = f.database.discover({ ...f.recording, sourceFingerprint: "source-v2" });
    assert.equal(await reuseCachedArtifact(changed, f.newRoot, f.config), null, "DB fingerprint can change without rebuilding old media");
});

test("missing, same-size corrupted, symlinked, and unregistered files are cache misses", async (t) => {
    const f = await fixture(t);
    const oldPath = await seed(f);
    const original = await fs.readFile(oldPath);
    await fs.writeFile(oldPath, Buffer.alloc(original.length, 42));
    assert.equal(await reuseCachedArtifact(f.recording, f.newRoot, f.config), null);
    assert.deepEqual(await fs.readdir(f.newRoot), [], "corrupt hit leaves no partial or final artifact");
    await fs.unlink(oldPath);
    assert.equal(await reuseCachedArtifact(f.recording, f.newRoot, f.config), null);
    const other = path.join(f.root, "other.mp4");
    await fs.writeFile(other, original);
    await fs.symlink(other, oldPath);
    assert.equal(await reuseCachedArtifact(f.recording, f.newRoot, f.config), null);
    await fs.unlink(oldPath);
    await fs.writeFile(oldPath, original);
    const raw = new DatabaseSync(f.config.databasePath);
    raw.exec("DELETE FROM artifacts");
    raw.close();
    assert.equal(await reuseCachedArtifact(f.recording, f.newRoot, f.config), null, "filename alone is not evidence");
});

test("cache refuses to overwrite conflicting destination and supports exclusive cross-device copy", async (t) => {
    const f = await fixture(t);
    const oldPath = await seed(f);
    await fs.mkdir(f.newRoot);
    const target = path.join(f.newRoot, path.basename(oldPath));
    await fs.writeFile(target, "keep this unrelated output");
    await assert.rejects(reuseCachedArtifact(f.recording, f.newRoot, f.config), /conflicts with an existing artifact/);
    assert.equal(await fs.readFile(target, "utf8"), "keep this unrelated output");
    await fs.unlink(target);
    const originalLink = fs.link;
    t.mock.method(fs, "link", async (source, destination) => {
        if (source === oldPath) throw Object.assign(new Error("different device"), { code: "EXDEV" });
        return originalLink(source, destination);
    });
    const hit = await reuseCachedArtifact(f.recording, f.newRoot, f.config);
    assert.equal(await artifactSha256(hit.path), await artifactSha256(oldPath));
    assert.notEqual((await fs.stat(hit.path)).ino, (await fs.stat(oldPath)).ino);
    assert.deepEqual(await fs.readdir(f.newRoot), [path.basename(target)]);
});

test("real cache miss converts; next generation reuses artifact + descriptor cache and submits a fresh upload", async (t) => {
    const f = await fixture(t);
    // Replace the placeholder DB fixture with the real finalized source identity.
    await fs.mkdir(f.recording.sourcePath);
    const part = await fixturePart(f.recording.sourcePath, "part", { size: "1280x720", frames: 3 });
    await assemble(f.recording.sourcePath, [part]);
    const inspected = await inspectRecording(f.recording.sourcePath, "tango", "edited");
    const raw = new DatabaseSync(f.config.databasePath);
    raw.prepare("UPDATE recordings SET source_fingerprint = ?, duration_seconds = ?").run(
        inspected.recording.sourceFingerprint, inspected.recording.durationSeconds);
    raw.close();
    f.recording = f.database.get(f.recording.id);
    let worker = new PipelineOrchestrator(f.database, createDefaultStages(f.oldRoot, f.config), "test-cache");
    assert.equal((await worker.processRecording(f.recording.id)).state, "remuxed");
    assert.equal((await worker.processRecording(f.recording.id)).state, "artifact_valid");
    const artifact = f.database.getArtifact(f.recording.id);
    assert.match(artifact.path, /\.production-v5\.mp4$/);

    // Seed actual descriptor evidence, then run the REAL descriptor cache path.
    // A miss must fail instead of ever starting the user's model/server.
    const previous = { ...descriptorConfig };
    Object.assign(descriptorConfig, { evidenceDirectory: path.join(f.root, "descriptions"),
        mediaDirectory: path.join(f.root, "descriptor-media"), runtimeExecutable: "/nonexistent-cache-test-runtime" });
    t.after(() => Object.assign(descriptorConfig, previous));
    const durationSeconds = await probeDuration(artifact.path);
    const fps = chooseVideoFps(durationSeconds, descriptorConfig.videoTokenBudget,
        descriptorConfig.tokensPerFrame, descriptorConfig.maximumFps);
    const promptVersion = createHash("sha256").update(await fs.readFile(descriptorConfig.promptPath)).digest("hex");
    const evidencePath = path.join(descriptorConfig.evidenceDirectory, "artifacts", artifact.sha256, promptVersion, "result.json");
    const description = { title: "Model generated title", description: "The original model description.", tags: ["room"] };
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(evidencePath, JSON.stringify({ inputPath: artifact.path, durationSeconds, fps, promptVersion, description,
        elapsedSeconds: 123, usage: {}, timings: {} }));

    let submissions = 0;
    async function describeAndUpload() {
        f.database.saveProvenance(f.recording.id, { observedIdentifier: "cache-test", status: "resolved",
            streamerId: "123", alias: "cache-test", streamerUrl: "https://tango.me/123",
            aliasUrl: "https://tango.me/cache-test", reason: null, updatedAt: new Date().toISOString() });
        assert.equal((await worker.processRecording(f.recording.id)).state, "described");
        assert.equal((await worker.processRecording(f.recording.id)).state, "metadata_ready");
        const cachedDescription = f.database.getDescription(f.recording.id);
        assert.equal(cachedDescription.evidencePath, evidencePath);
        assert.deepEqual(cachedDescription.output, description);
        const metadata = f.database.getUploadMetadata(f.recording.id);
        assert.equal(metadata.title, `Model generated title [${f.recording.id}]`);
        assert.doesNotMatch(metadata.title, /production-v|upscale1080p|\.mp4/);
        const currentArtifact = f.database.getArtifact(f.recording.id);
        const reservation = f.database.reserveUpload(f.recording.id, currentArtifact.sizeBytes);
        const uploader = { async upload(request) {
            submissions++;
            assert.equal(request.artifactPath, currentArtifact.path);
            return { kind: "uploaded", receipt: { transmittedBytes: request.sizeBytes,
                submittedVideoId: String(100 + submissions), metadataSubmittedAt: new Date().toISOString() } };
        } };
        await new UploadCoordinator(f.database, uploader).uploadAdmitted(f.recording.id, reservation, {
            recordingId: f.recording.id, uploadIdentity: `${f.recording.id} | ${f.database.getProductionVersion()} | full`,
            artifactPath: currentArtifact.path, sizeBytes: currentArtifact.sizeBytes, ...metadata, visibility: "private",
        });
    }
    await describeAndUpload();
    assert.equal(submissions, 1);
    f.recording = await rollover(f);
    assert.equal(f.database.getUploadIdentity(f.recording.id), null, "old upload cannot suppress fresh-generation upload");
    worker = new PipelineOrchestrator(f.database, createDefaultStages(f.newRoot, f.config), "test-cache-next");
    // A hit must not touch the playlist, probe segments, or invoke conversion.
    await fs.rename(f.recording.playlistPath, `${f.recording.playlistPath}.test-hidden`);
    assert.equal((await worker.processRecording(f.recording.id)).state, "remuxed");
    await fs.rename(`${f.recording.playlistPath}.test-hidden`, f.recording.playlistPath);
    assert(f.database.hasResolutionPolicyAssessment(f.recording.id, "resolution-policy-v5"));
    // Also exercise a process restart between reuse and artifact validation.
    worker = new PipelineOrchestrator(f.database, createDefaultStages(f.newRoot, f.config), "test-cache-restarted");
    assert.equal((await worker.processRecording(f.recording.id)).state, "artifact_valid");
    assert.equal(f.database.getArtifact(f.recording.id).sha256, artifact.sha256);
    assert.equal(path.dirname(f.database.getArtifact(f.recording.id).path), f.newRoot);
    await describeAndUpload();
    assert.equal(submissions, 2, "same artifact and same description, genuinely new upload call");
    assert.equal(f.database.getUploadIdentity(f.recording.id).remoteId, "102");
    assert((await fs.stat(artifact.path)).isFile(), "old comparison retained");
});
