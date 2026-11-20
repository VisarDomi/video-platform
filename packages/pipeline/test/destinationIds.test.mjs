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
        contentProfile: "profile-original",
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
    const check = cli(["metadata-check", "--provider", "oldhost"], env);
    assert.equal(check.status, 1, "a retired or unknown destination has nothing to check");
    assert.match(check.stderr, /The sites file names no destination "oldhost"/);

    const switched = cli(["upload-provider", "--provider", "form-host", "--apply"], env);
    assert.equal(switched.status, 0, switched.stderr);
    assert.equal(JSON.parse(switched.stdout).activeUploadProvider, "form-host");
});

test("a destination's limits and creation boundary come from its plug-in; VideoHost keeps the pinned table", async (t) => {
    const { destinationFacts } = await import("../dist/upload/destinationFacts.js");
    const videohost = await destinationFacts("videohost");
    assert.equal(videohost.creationBoundary, "metadata_submit");
    assert.equal(videohost.uploadVisibility, "public");
    assert.equal(videohost.policy.minimumDurationSeconds, 120);
    assert.equal(videohost.policy.maximumFileBytes, 10_000_000_000);

    const { directory } = await ledger(t);
    const sitesFile = path.join(directory, "sites.json");
    await writeFile(sitesFile, JSON.stringify({ destinations: [{ id: "form-host", plugin: "plugin-form-host", config: { baseUrl: "http://127.0.0.1:1" } }], sites: [] }));
    const previous = process.env.VIDEO_SITES_FILE;
    process.env.VIDEO_SITES_FILE = sitesFile;
    t.after(() => { process.env.VIDEO_SITES_FILE = previous; });
    const formHost = await destinationFacts("form-host");
    assert.deepEqual({ ...formHost, policy: { ...formHost.policy } }, {
        creationBoundary: "metadata_submit", uploadVisibility: "public",
        policy: { providers: [], minimumDurationSeconds: null, maximumDurationSeconds: null, maximumFileBytes: 10 * 1024 ** 3, unresolvedConstraints: [] },
    });
    await assert.rejects(destinationFacts("api-host"), /names no destination "api-host"/);
});

test("only a destination whose copy starts at the metadata form settles unsubmitted attempts", async (t) => {
    const { directory, databasePath } = await ledger(t);
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    const sourcePath = path.join(directory, "2026-01-01 010000 fixture");
    const recording = database.discover({ provider: "tslive", sourceKind: "edited", sourcePath,
        playlistPath: path.join(sourcePath, "playlist.m3u8"), sourceFingerprint: "fingerprint", durationSeconds: 600 });
    // An attempt interrupted during the file transfer: uncertain, never at the metadata form.
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE recordings SET state = 'upload_uncertain' WHERE id = ?").run(recording.id);
    raw.prepare(`INSERT INTO upload_attempts (id, recording_id, provider, status, phase, started_at)
        VALUES ('attempt-1', ?, 'form-host', 'uncertain', 'file_uploading', '2026-01-02T00:00:00.000Z')`).run(recording.id);
    raw.close();
    const attempt = () => { const db = new DatabaseSync(databasePath, { readOnly: true }); try { return { ...db.prepare("SELECT status FROM upload_attempts WHERE id = 'attempt-1'").get() }; } finally { db.close(); } };

    // A copy that may exist from the first byte: nothing is settled as harmless.
    assert.deepEqual(database.settleUnsubmittedAttempts("form-host", "transfer_start"), []);
    assert.equal(attempt().status, "uncertain");
    assert.equal(database.get(recording.id).state, "upload_uncertain");
    // A copy made only by the metadata form: the transfer published nothing.
    assert.deepEqual(database.settleUnsubmittedAttempts("form-host", "metadata_submit"), [recording.id]);
    assert.equal(attempt().status, "failed");
    assert.equal(database.get(recording.id).state, "metadata_ready");
});

test("a trial's progress lists the configured sources in order, then any other source with trial recordings", async (t) => {
    const { directory, databasePath } = await ledger(t);
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    database.configureCampaign("all", 1_000_000_000, new Date(), 2);
    const sourcePath = path.join(directory, "2026-01-01 010000 fixture");
    const recording = database.discover({ provider: "tslive", sourceKind: "edited", sourcePath,
        playlistPath: path.join(sourcePath, "playlist.m3u8"), sourceFingerprint: "fingerprint", durationSeconds: 600 });
    database.enrollCampaignTrial(recording);
    assert.deepEqual(database.getCampaignTrialProgress(["tslive", "ladder", "fmp4"]).map(({ provider, admitted }) => [provider, admitted]),
        [["tslive", 1], ["ladder", 0], ["fmp4", 0]], "production's sources, as before");
    assert.deepEqual(database.getCampaignTrialProgress(["live-a"]).map(({ provider, admitted }) => [provider, admitted]),
        [["live-a", 0], ["tslive", 1]], "an admitted recording is never left out");
});

test("an older server's resolution (no pages) stores nothing; a site without pages goes to review", async () => {
    const { TargetCatalogResolver, SourcePagesUnavailableError } = await import("../dist/provenance/targetResolver.js");
    const input = { provider: "live-a", sourceKind: "edited", sourcePath: "/x/2026-01-01 010000 court", playlistPath: "/x/p.m3u8", sourceFingerprint: "f", durationSeconds: 1 };
    const older = TargetCatalogResolver.load({ resolveIdentifier: async () => ({ id: "1", label: "court" }) });
    await assert.rejects(older.resolve(input), SourcePagesUnavailableError);
    const pageless = TargetCatalogResolver.load({ resolveIdentifier: async () => ({ id: "1", label: "court", channelUrl: null, aliasUrl: null }) });
    const review = await pageless.resolve(input);
    assert.equal(review.status, "review_required");
    assert.equal(review.reason, "no_source_links:live-a");
    const linked = TargetCatalogResolver.load({ resolveIdentifier: async () => ({ id: "1", label: "court", channelUrl: "https://live-a.test/1", aliasUrl: "https://live-a.test/@court" }) });
    const resolved = await linked.resolve(input);
    assert.deepEqual([resolved.status, resolved.streamerUrl, resolved.aliasUrl], ["resolved", "https://live-a.test/1", "https://live-a.test/@court"]);
});

test("a destination build without a creation boundary is refused; settling then skips once instead of stopping", async (t) => {
    const { destinationFacts, settleUnsubmitted } = await import("../dist/upload/destinationFacts.js");
    const { directory } = await ledger(t);
    const stale = path.join(directory, "stale-destination.mjs");
    await writeFile(stale, `export const destination = { id: "old", sdkVersion: 1, createDestination() {} };`);
    const sitesFile = path.join(directory, "sites.json");
    await writeFile(sitesFile, JSON.stringify({ destinations: [{ id: "old", plugin: `file://${stale}` }], sites: [] }));
    const previous = process.env.VIDEO_SITES_FILE;
    process.env.VIDEO_SITES_FILE = sitesFile;
    t.after(() => { process.env.VIDEO_SITES_FILE = previous; });
    await assert.rejects(destinationFacts("old"), /declares no creation boundary/);
    const calls = [];
    const database = { getActiveUploadProvider: () => "old", settleUnsubmittedAttempts: (...args) => { calls.push(args); return ["x"]; } };
    const logged = [];
    const error = console.error;
    console.error = (line) => logged.push(String(line));
    try { assert.deepEqual(await settleUnsubmitted(database), []); } finally { console.error = error; }
    assert.deepEqual(calls, [], "nothing settled without the boundary");
    assert.match(logged.join("\n"), /destination-facts-unavailable/);
});
