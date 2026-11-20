// Destination and source IDs are data (schema 17): the ledger stores any well-formed ID,
// the sites file says which exist, and a retired destination never becomes active again.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { providerFolders } from "shared";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { assertUploadProvider } from "../dist/config/uploadProviders.js";
import { pipelineConfig, sourceSiteIds } from "../dist/config.js";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

async function ledger(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-pipeline-destination-ids-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const databasePath = path.join(directory, "pipeline.sqlite");
    return { directory, databasePath };
}

test("a destination ID is any well-formed ID", () => {
    for (const id of ["videohost", "form-host", "api-host2"]) assertUploadProvider(id);
    for (const id of ["", "VideoHost", "form host", "a/b", "-x", "retired", 7, null]) assert.throws(() => assertUploadProvider(id), /destination ID/);
});

test("the ledger stores a new destination and refuses a retired one", async (t) => {
    const { databasePath } = await ledger(t);
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    const raw = new DatabaseSync(databasePath);
    raw.prepare("INSERT INTO destinations VALUES ('old-host', 'retired', NULL, 'at')").run();
    raw.close();
    assert.throws(() => database.setActiveUploadProvider("old-host"), /Upload provider old-host is retired/);
    assert.equal(database.getActiveUploadProvider(), "videohost");
    database.setActiveUploadProvider("form-host");
    assert.equal(database.getActiveUploadProvider(), "form-host");
    assert.deepEqual(database.listUploadProviderEvents().map(({ fromProvider, toProvider }) => [fromProvider, toProvider]), [["videohost", "form-host"]]);
});

test("a campaign filters by any site ID the ledger is given", async (t) => {
    const { databasePath } = await ledger(t);
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    assert.equal(database.configureCampaign("live-a", 1_000).providerFilter, "live-a");
    assert.equal(database.configureCampaign("all", 1_000).providerFilter, "all");
    assert.throws(() => database.configureCampaign("Live A", 1_000), /Campaign provider must be all or a site ID/);
});

test("the pipeline's sources are the sites file's sites, in its order", () => {
    // The test sites file lists production's three sites.
    assert.deepEqual(sourceSiteIds(), ["tslive", "ladder", "fmp4"]);
    assert.deepEqual(pipelineConfig.discoveryRoots, ["tslive", "ladder", "fmp4"].map((provider) => ({
        provider, sourceKind: "edited", path: providerFolders(provider).edited,
    })));
    assert.deepEqual(pipelineConfig.manualRemuxRoots.map(({ provider, sourceKind }) => `${provider}/${sourceKind}`),
        ["tslive/downloader", "tslive/edited", "ladder/downloader", "ladder/edited", "fmp4/downloader", "fmp4/edited"]);
});

function cli(args, env) {
    return spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
}

test("the CLI checks campaign sources and destinations against the sites file", async (t) => {
    const { directory, databasePath } = await ledger(t);
    const sitesFile = path.join(directory, "sites.json");
    await writeFile(sitesFile, JSON.stringify({
        destinations: [{ id: "videohost", plugin: "plugin-videohost" }, { id: "form-host", plugin: "plugin-form-host" }],
        sites: [{ id: "tslive", plugin: "plugin-tslive" }, { id: "ladder", plugin: "plugin-ladder" }, { id: "fmp4", plugin: "plugin-fmp4" }],
    }));
    const env = { VIDEO_PIPELINE_DB: databasePath, VIDEO_SITES_FILE: sitesFile };

    const badSource = cli(["campaign-configure", "--provider", "live-a", "--apply"], env);
    assert.equal(badSource.status, 1);
    // The message production prints, from the sites file's list.
    assert.match(badSource.stderr, /Campaign provider must be all, tslive, ladder, or fmp4/);

    const unknown = cli(["upload-provider", "--provider", "api-host", "--apply"], env);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /The sites file names no destination "api-host"/);

    const switched = cli(["upload-provider", "--provider", "form-host", "--apply"], env);
    assert.equal(switched.status, 0, switched.stderr);
    assert.equal(JSON.parse(switched.stdout).activeUploadProvider, "form-host");
});
