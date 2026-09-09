import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

import { remuxOne } from "../dist/commands/remuxOne.js";

const execFileAsync = promisify(execFile);

test("manual remux accepts an exact server-verified downloader folder outside production discovery", async (t) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipeline-remux-one-"));
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
    const managedRoot = path.join(temporaryRoot, "downloads", "tango", "downloader");
    const recordingPath = path.join(managedRoot, "recording");
    const dataRoot = path.join(temporaryRoot, "data");
    await mkdir(recordingPath, { recursive: true });

    const segmentPath = path.join(recordingPath, "00001.ts");
    await execFileAsync("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=10",
        "-t", "0.3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-f", "mpegts", segmentPath,
    ]);
    const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.3,\n00001.ts\n#EXT-X-ENDLIST\n";
    await writeFile(path.join(recordingPath, "playlist.m3u8"), playlist);

    const finalizationDatabasePath = path.join(dataRoot, "finalization.sqlite");
    await mkdir(dataRoot, { recursive: true });
    const authority = new DatabaseSync(finalizationDatabasePath);
    authority.exec(`
        CREATE TABLE integrity_checkpoints (
            recording_path TEXT PRIMARY KEY,
            playlist_fingerprint TEXT NOT NULL,
            report_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        ) STRICT
    `);
    authority.prepare("INSERT INTO integrity_checkpoints VALUES (?, ?, ?, ?)").run(
        recordingPath,
        createHash("sha256").update(playlist).digest("hex"),
        JSON.stringify({ version: 2, status: "ready" }),
        "2026-08-12T10:00:00.000Z",
    );
    authority.close();

    const artifactsRoot = path.join(dataRoot, "artifacts");
    const config = {
        finalizationDatabasePath,
        databasePath: path.join(dataRoot, "pipeline.sqlite"),
        artifactsRoot,
        stagingRoot: path.join(artifactsRoot, "production-v3"),
        manualStagingRoot: path.join(artifactsRoot, "production-v3", "manual"),
        discoveryRoots: [{
            provider: "tango",
            sourceKind: "edited",
            path: path.join(temporaryRoot, "downloads", "tango", "editor", "edited"),
        }],
        manualRemuxRoots: [{ provider: "tango", sourceKind: "downloader", path: managedRoot }],
        uploadTimeZone: "Europe/Tirane",
        monthlyUploadLimitBytes: 600_000_000_000,
        cleanupEnabled: false,
        networkUploadsEnabled: false,
    };
    const result = await remuxOne(recordingPath, config);
    assert.equal(result.authority, "recording-checkpoint");
    assert.equal(result.state, "artifact_valid");
    assert.equal(result.videoCodec, "h264");
    assert.equal(result.artifactMode, "stream-copy");
    assert.equal(result.videoWidth, 1280);
    assert.equal(result.videoHeight, 720);
    assert.equal(result.sourceFrameCount, null);
    assert.equal(result.droppedSourceFrames, null);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(path.dirname(result.artifactPath), config.stagingRoot);

    const ledgerBeforeVariant = new DatabaseSync(config.databasePath, { readOnly: true });
    const stateBeforeVariant = ledgerBeforeVariant
        .prepare("SELECT state FROM recordings WHERE id = ?").get(result.recordingId).state;
    ledgerBeforeVariant.close();
    const upscale = await remuxOne(recordingPath, config, { upscaleMode: "upscale1080p" });
    assert.equal(upscale.state, stateBeforeVariant);
    assert.equal(upscale.artifactMode, "upscale1080p");
    assert.equal(upscale.videoWidth, 1920);
    assert.equal(upscale.videoHeight, 1080);
    assert.equal(upscale.sampleAspectRatio, "1:1");
    assert.equal(upscale.displayAspectRatio, "16:9");
    assert.equal(upscale.pixelFormat, "yuv420p");
    assert.equal(upscale.sourceFrameCount, 3);
    assert.equal(upscale.droppedSourceFrames, 0);
    assert.notEqual(upscale.artifactPath, result.artifactPath);
    assert.match(upscale.artifactPath, /\.upscale1080p\.mp4$/);
    assert.equal(path.dirname(upscale.artifactPath), config.manualStagingRoot);

    const ledger = new DatabaseSync(config.databasePath, { readOnly: true });
    const canonical = ledger.prepare("SELECT path FROM artifacts WHERE recording_id = ?").get(result.recordingId);
    const variant = ledger.prepare(`
        SELECT variant, path FROM artifact_variants WHERE recording_id = ? AND variant = 'upscale1080p'
    `).get(result.recordingId);
    const stateAfterVariant = ledger.prepare("SELECT state FROM recordings WHERE id = ?").get(result.recordingId).state;
    ledger.close();
    assert.equal(canonical.path, result.artifactPath);
    assert.equal(variant.path, upscale.artifactPath);
    assert.equal(stateAfterVariant, stateBeforeVariant);
});

test("single remux refuses a historical folder without exact server authority", async (t) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipeline-remux-unverified-"));
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
    const managedRoot = path.join(temporaryRoot, "edited");
    const recordingPath = path.join(managedRoot, "recording");
    await mkdir(recordingPath, { recursive: true });
    await writeFile(path.join(recordingPath, "playlist.m3u8"), "#EXTM3U\n#EXTINF:1,\n1.ts\n#EXT-X-ENDLIST\n");
    await writeFile(path.join(recordingPath, "1.ts"), "not inspected because authority is absent");

    await assert.rejects(remuxOne(recordingPath, {
        finalizationDatabasePath: path.join(temporaryRoot, "missing.sqlite"),
        databasePath: path.join(temporaryRoot, "pipeline.sqlite"),
        artifactsRoot: path.join(temporaryRoot, "artifacts"),
        stagingRoot: path.join(temporaryRoot, "artifacts", "production-v3"),
        manualStagingRoot: path.join(temporaryRoot, "artifacts", "production-v3", "manual"),
        discoveryRoots: [{ provider: "sc", sourceKind: "edited", path: managedRoot }],
        manualRemuxRoots: [{ provider: "sc", sourceKind: "edited", path: managedRoot }],
        uploadTimeZone: "Europe/Tirane",
        monthlyUploadLimitBytes: 600_000_000_000,
        cleanupEnabled: false,
        networkUploadsEnabled: false,
    }), /no matching successful server checkpoint/);
});
