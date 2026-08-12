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

test("one exact server-verified folder is remuxed and validated without a global contract", async (t) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipeline-remux-one-"));
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
    const managedRoot = path.join(temporaryRoot, "downloads", "tango", "editor", "edited");
    const recordingPath = path.join(managedRoot, "recording");
    const dataRoot = path.join(temporaryRoot, "data");
    await mkdir(recordingPath, { recursive: true });

    const segmentPath = path.join(recordingPath, "00001.ts");
    await execFileAsync("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10",
        "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-f", "mpegts", segmentPath,
    ]);
    const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n00001.ts\n#EXT-X-ENDLIST\n";
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

    const config = {
        finalizationDatabasePath,
        databasePath: path.join(dataRoot, "pipeline.sqlite"),
        stagingRoot: path.join(dataRoot, "artifacts"),
        discoveryRoots: [{ provider: "tango", sourceKind: "edited", path: managedRoot }],
        uploadTimeZone: "Europe/Tirane",
        monthlyUploadLimitBytes: 600_000_000_000,
        cleanupEnabled: false,
        networkUploadsEnabled: false,
    };
    const result = await remuxOne(recordingPath, config);
    assert.equal(result.authority, "recording-checkpoint");
    assert.equal(result.state, "artifact_valid");
    assert.equal(result.videoCodec, "h264");
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(path.dirname(result.artifactPath), config.stagingRoot);
});

test("single remux refuses a historical folder without exact or global server authority", async (t) => {
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
        stagingRoot: path.join(temporaryRoot, "artifacts"),
        discoveryRoots: [{ provider: "sc", sourceKind: "edited", path: managedRoot }],
        uploadTimeZone: "Europe/Tirane",
        monthlyUploadLimitBytes: 600_000_000_000,
        cleanupEnabled: false,
        networkUploadsEnabled: false,
    }), /no matching successful server checkpoint/);
});
