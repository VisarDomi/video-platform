import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pipelineConfig } from "../dist/config.js";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { setCampaignRunning } from "../dist/commands/campaign.js";
import { syncComparisonSelection } from "../dist/commands/comparisonTrial.js";
import { inspectFinalizedRecording } from "../dist/discovery/inspectRecording.js";
import { fixturePart, assemble, frameIds } from "./helpers/mediaFixture.mjs";
import { upscaleWholeRecordingTo1080 } from "../dist/stages/upscale.js";

async function eventually(check, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("Timed out waiting for subprocess state");
}
async function setup(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-process-recovery-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const edited = path.join(root, "edited");
    const config = { ...pipelineConfig, databasePath: path.join(root, "pipeline.sqlite"),
        finalizationDatabasePath: path.join(root, "finalization.sqlite"),
        artifactsRoot: path.join(root, "artifacts"), stagingRoot: path.join(root, "artifacts", "production-v3"),
        comparisonSelectionFile: path.join(root, "test-videos.txt"), networkUploadsEnabled: false,
        serverUrl: "https://127.0.0.1:1", credentialsFilePath: path.join(root, "no-credentials"),
        discoveryRoots: [{ provider: "tango", sourceKind: "edited", path: edited }] };
    await mkdir(edited);
    await writeFile(config.comparisonSelectionFile, "");
    await setCampaignRunning(config, false, true);
    const database = new PipelineDatabase(config.databasePath);
    t.after(() => database.close());
    const authority = new DatabaseSync(config.finalizationDatabasePath);
    authority.exec("CREATE TABLE integrity_checkpoints (recording_path TEXT PRIMARY KEY, playlist_fingerprint TEXT, report_json TEXT, updated_at TEXT)");
    authority.close();
    return { root, edited, config, database };
}
async function checkpoint(config, source) {
    const playlist = await readFile(path.join(source, "playlist.m3u8"), "utf8");
    const db = new DatabaseSync(config.finalizationDatabasePath);
    db.prepare("INSERT INTO integrity_checkpoints VALUES (?, ?, ?, ?)").run(source,
        createHash("sha256").update(playlist).digest("hex"), JSON.stringify({ version: 2, status: "ready" }), new Date().toISOString());
    db.close();
}
function child(t, code, args) {
    const processChild = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code, ...args],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    processChild.stdout.on("data", (s) => { output += s; });
    processChild.stderr.on("data", (s) => { output += s; });
    const exited = once(processChild, "exit");
    const stop = async (signal = "SIGKILL") => {
        if (processChild.exitCode === null && processChild.signalCode === null) {
            process.kill(-processChild.pid, signal);
            await exited;
        }
    };
    t.after(() => stop());
    return { processChild, stop, output: () => output };
}
function worker(t, config) {
    return child(t, `import {runCampaignWorker} from ${JSON.stringify(new URL("../dist/commands/runCampaignWorker.js", import.meta.url).href)};
        const controller = new AbortController(); process.on("SIGTERM", () => controller.abort());
        await runCampaignWorker(JSON.parse(process.argv[1]), controller.signal);`, [JSON.stringify(config)]);
}

test("real paused worker observes additions and pending cancellation across SIGKILL without processing", async (t) => {
    const { edited, config, database } = await setup(t);
    const source = path.join(edited, "2026-01-01 000000 selection");
    await mkdir(source);
    await writeFile(path.join(source, "playlist.m3u8"), "#EXTM3U\n#EXTINF:1,\n1.ts\n#EXT-X-ENDLIST\n");
    await writeFile(path.join(source, "1.ts"), "not decoded by selection watcher");
    await checkpoint(config, source);
    const first = worker(t, config);
    await eventually(() => first.output().includes("campaign-step"));
    await writeFile(config.comparisonSelectionFile, `${source}\n${source}\n`);
    await eventually(() => database.getComparisonTrial().selection.length === 1, 38_000);
    assert.equal(database.list().length, 0, "paused worker must not process selected sources");
    await first.stop();
    await writeFile(config.comparisonSelectionFile, "");
    const restarted = worker(t, config);
    await eventually(() => restarted.output().includes("campaign-step"));
    assert.equal(database.getComparisonTrial().selection.length, 0, "restart applies removal of unstarted work");
    assert.equal(database.getCampaignControl().state, "paused");
    assert.equal(database.list().length, 0);
    await restarted.stop("SIGTERM");
});

test("killing an actual encoder leaves no published artifact; worker restart clears lease and retry ignores partial", async (t) => {
    const { root, edited, config, database } = await setup(t);
    const source = path.join(edited, "2026-01-01 000000 interrupted");
    const part = await fixturePart(source, "generated", { frames: 60 });
    const playlist = await assemble(source, [part]);
    await checkpoint(config, source);
    await writeFile(config.comparisonSelectionFile, source + "\n");
    await syncComparisonSelection(config);
    const inspected = await inspectFinalizedRecording(source, "tango", "edited");
    assert.equal(inspected.status, "finalized");
    const recording = database.discover(inspected.recording);
    const encoder = child(t, `
        import {PipelineDatabase} from ${JSON.stringify(new URL("../dist/db/pipelineDatabase.js", import.meta.url).href)};
        import {PipelineOrchestrator} from ${JSON.stringify(new URL("../dist/scheduler/orchestrator.js", import.meta.url).href)};
        import {createDefaultStages} from ${JSON.stringify(new URL("../dist/stages/defaultStages.js", import.meta.url).href)};
        const config=JSON.parse(process.argv[1]); const db=new PipelineDatabase(config.databasePath);
        await new PipelineOrchestrator(db,createDefaultStages(config.stagingRoot),"crash-test").processRecording(process.argv[2]);
        db.close();`, [JSON.stringify(config), recording.id]);
    await eventually(async () => (await readdir(config.stagingRoot)).some((p) => p.endsWith(".partial.mp4")));
    await encoder.stop();
    assert.equal(database.get(recording.id).state, "server_ready");
    assert.equal(database.get(recording.id).leaseOwner, "crash-test");
    const final = path.join(config.stagingRoot, `${recording.id}.production-upscale1080p.mp4`);
    await assert.rejects(() => access(final));
    const restarted = worker(t, config);
    await eventually(() => restarted.output().includes("campaign-step"));
    assert.equal(database.get(recording.id).leaseOwner, null);
    await restarted.stop("SIGTERM");
    const result = await upscaleWholeRecordingTo1080(playlist, config.stagingRoot, recording.id,
        { width: 320, height: 180, sampleAspectRatio: "1:1" });
    assert.equal(result.path, final);
    assert.equal((await frameIds(final)).length, 60);
    assert.equal(database.getCampaignControl().state, "paused");
    assert.equal(database.getArtifact(recording.id), null, "manual test retry must not mark an upload or advance DB");
});
