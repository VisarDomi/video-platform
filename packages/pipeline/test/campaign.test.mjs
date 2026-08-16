import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { pipelineConfig } from "../dist/config.js";
import { captureKeyFromFolderName, selectOldestFinalizedEditedCandidate } from "../dist/campaign/selectCandidate.js";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";

async function addFinalized(authority, root, folderName) {
    const recordingPath = path.join(root, folderName);
    await mkdir(recordingPath, { recursive: true });
    const playlist = "#EXTM3U\n#EXTINF:1,\n1.ts\n#EXT-X-ENDLIST\n";
    await writeFile(path.join(recordingPath, "playlist.m3u8"), playlist);
    await writeFile(path.join(recordingPath, "1.ts"), "media");
    authority.prepare("INSERT INTO integrity_checkpoints VALUES (?, ?, ?, ?)").run(
        recordingPath,
        createHash("sha256").update(playlist).digest("hex"),
        JSON.stringify({ version: 2, status: "ready" }),
        "2026-08-14T08:00:00.000Z",
    );
    return recordingPath;
}

test("production roots are edited-only while manual remux roots retain downloader access", () => {
    assert.equal(pipelineConfig.discoveryRoots.length, 3);
    assert(pipelineConfig.discoveryRoots.every((root) => root.sourceKind === "edited"));
    assert(pipelineConfig.discoveryRoots.every((root) => root.path.endsWith("edited")));
    assert.equal(pipelineConfig.manualRemuxRoots.filter((root) => root.sourceKind === "downloader").length, 3);
    assert.equal(pipelineConfig.manualRemuxRoots.filter((root) => root.sourceKind === "edited").length, 3);
});

test("capture timestamps are strict and sortable", () => {
    assert.equal(captureKeyFromFolderName("2025-02-03 040506 alias"), "2025-02-03T04:05:06");
    assert.equal(captureKeyFromFolderName("2025-02-30 040506 alias"), null);
    assert.equal(captureKeyFromFolderName("recording"), null);
});

test("campaign selection uses exact ready checkpoints, edited roots, oldest time, and provider filters", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-campaign-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const finalizationPath = path.join(root, "finalization.sqlite");
    const authority = new DatabaseSync(finalizationPath);
    authority.exec(`CREATE TABLE integrity_checkpoints (
        recording_path TEXT PRIMARY KEY,
        playlist_fingerprint TEXT NOT NULL,
        report_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    ) STRICT`);
    const tangoEdited = path.join(root, "tango", "edited");
    const fc2Edited = path.join(root, "fc2", "edited");
    const tangoDownloader = path.join(root, "tango", "downloaded");
    const tangoPath = await addFinalized(authority, tangoEdited, "2025-02-03 040506 tango_alias");
    const fc2Path = await addFinalized(authority, fc2Edited, "2024-01-02 030405 12345");
    await addFinalized(authority, tangoDownloader, "2020-01-01 000000 ignored_raw");
    authority.close();

    const database = new PipelineDatabase(path.join(root, "pipeline.sqlite"));
    t.after(() => database.close());
    const roots = [
        { provider: "tango", sourceKind: "edited", path: tangoEdited },
        { provider: "fc2", sourceKind: "edited", path: fc2Edited },
    ];
    const oldest = await selectOldestFinalizedEditedCandidate({
        finalizationDatabasePath: finalizationPath,
        roots,
        providerFilter: "all",
        pipelineDatabase: database,
    });
    assert.equal(oldest?.sourcePath, fc2Path);
    database.discover(oldest);
    const next = await selectOldestFinalizedEditedCandidate({
        finalizationDatabasePath: finalizationPath,
        roots,
        providerFilter: "all",
        pipelineDatabase: database,
    });
    assert.equal(next?.sourcePath, tangoPath);
    const emptyDatabase = new PipelineDatabase(":memory:");
    const tangoOnly = await selectOldestFinalizedEditedCandidate({
        finalizationDatabasePath: finalizationPath,
        roots,
        providerFilter: "tango",
        pipelineDatabase: emptyDatabase,
    });
    assert.equal(tangoOnly?.sourcePath, tangoPath);
    emptyDatabase.close();
});

test("campaign intent and limits persist independently of worker lifetime", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-campaign-control-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const databasePath = path.join(root, "pipeline.sqlite");
    const first = new PipelineDatabase(databasePath);
    assert.equal(first.getCampaignControl().state, "paused");
    first.configureCampaign("sc", 123_456_789);
    first.setCampaignState("running");
    first.close();
    const reopened = new PipelineDatabase(databasePath);
    assert.deepEqual({
        state: reopened.getCampaignControl().state,
        provider: reopened.getCampaignControl().providerFilter,
        limit: reopened.getCampaignControl().monthlyUploadLimitBytes,
    }, { state: "running", provider: "sc", limit: 123_456_789 });
    reopened.setCampaignState("paused");
    reopened.close();
});
