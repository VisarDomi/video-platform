// The ledger's schema: a new ledger is created whole, in one transaction, with the sites
// file's first destination; opening an existing one changes nothing and takes no write
// lock; the database itself refuses a bad or retired destination; an older schema is
// refused untouched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";

const MODULE = new URL("../dist/db/pipelineDatabase.js", import.meta.url).href;

// A folder with a sites file naming form-host first, used for the test's duration.
async function setting(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-pipeline-ledger-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sitesFile = path.join(directory, "sites.json");
    await writeFile(sitesFile, JSON.stringify({ destinations: [{ id: "form-host", plugin: "plugin-form-host" }, { id: "api-host", plugin: "plugin-api-host" }], sites: [] }));
    const previous = process.env.VIDEO_SITES_FILE;
    process.env.VIDEO_SITES_FILE = sitesFile;
    t.after(() => { if (previous === undefined) delete process.env.VIDEO_SITES_FILE; else process.env.VIDEO_SITES_FILE = previous; });
    return { directory, sitesFile, databasePath: path.join(directory, "pipeline.sqlite") };
}

// A ledger with a recording, a campaign setting and a removal in it.
async function ledger(t) {
    const { directory, databasePath, sitesFile } = await setting(t);
    const database = new PipelineDatabase(databasePath);
    const sourcePath = path.join(directory, "2026-01-01 010000 fixture");
    const recording = database.discover({ provider: "live-a", sourceKind: "edited", sourcePath,
        playlistPath: path.join(sourcePath, "playlist.m3u8"), sourceFingerprint: "fingerprint", durationSeconds: 600 });
    database.configureCampaign("all", 123_456_789);
    database.close();
    return { directory, databasePath, sitesFile, recording };
}

// Every table's columns (in order) and rows with their rowids, and the stored schema.
function contents(databasePath) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        const entries = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
        return Object.fromEntries(entries.map(({ type, name, sql }) => {
            if (type !== "table") return [name, { sql }];
            const columns = database.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().map((column) => column.name);
            const rows = database.prepare(`SELECT rowid AS "rowid()", * FROM "${name}"`).all()
                .map((row) => JSON.stringify([row["rowid()"], ...columns.map((column) => row[column])])).sort();
            return [name, { sql, columns, rows }];
        }));
    } finally { database.close(); }
}

const tableCount = (databasePath) => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n; } finally { database.close(); }
};

test("a new ledger starts paused, on the current generation, with the sites file's first destination", async (t) => {
    const { databasePath } = await setting(t);
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    const control = database.getCampaignControl();
    assert.equal(control.state, "paused");
    assert.equal(control.uploadProvider, "form-host");
    assert.equal(database.getActiveUploadProvider(), "form-host");
    assert.equal(database.integrityCheck(), "ok");
});

test("a new ledger needs a destination: without one nothing is created", async (t) => {
    const { databasePath, sitesFile } = await setting(t);
    await writeFile(sitesFile, JSON.stringify({ sites: [] }));
    assert.throws(() => new PipelineDatabase(databasePath), /names no destination/);
    assert.equal(tableCount(databasePath), 0);
});

test("opening a ledger again changes nothing", async (t) => {
    const { databasePath } = await ledger(t);
    const before = contents(databasePath);
    new PipelineDatabase(databasePath).close();
    new PipelineDatabase(databasePath).close();
    assert.deepEqual(contents(databasePath), before);
});

test("opening an existing ledger takes no write lock and needs no sites file", async (t) => {
    const { databasePath, sitesFile } = await ledger(t);
    await rm(sitesFile);
    const writer = new DatabaseSync(databasePath);
    t.after(() => writer.close());
    writer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    try {
        const started = Date.now();
        const database = new PipelineDatabase(databasePath);
        assert.equal(database.getActiveUploadProvider(), "form-host");
        database.close();
        assert.ok(Date.now() - started < 5_000, "the open did not wait for the writer");
    } finally { writer.exec("ROLLBACK"); }
});

test("SIGKILL in the middle of creating a ledger leaves none; the next open creates it whole", async (t) => {
    const { databasePath, sitesFile } = await setting(t);
    // The child creates every table, then stops for good inside the transaction, just
    // before writing the campaign row, and is killed there.
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
        import { writeSync } from "node:fs";
        import { DatabaseSync } from "node:sqlite";
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function (sql) {
            if (sql.includes("INSERT INTO campaign_control")) {
                writeSync(1, "inside");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            }
            return prepare.call(this, sql);
        };
        const { PipelineDatabase } = await import(${JSON.stringify(MODULE)});
        new PipelineDatabase(process.argv[1]);
    `, databasePath], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VIDEO_SITES_FILE: sitesFile } });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [chunk] = await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error(`child exited first: ${stderr}`); })]);
    assert.equal(String(chunk), "inside");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;

    assert.equal(tableCount(databasePath), 0, "the killed transaction left nothing behind");
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    assert.equal(database.getActiveUploadProvider(), "form-host");
    assert.equal(database.integrityCheck(), "ok");
});

test("two processes creating the same ledger at once end with one ledger", async (t) => {
    const { databasePath, sitesFile } = await setting(t);
    const open = () => spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
        const { PipelineDatabase } = await import(${JSON.stringify(MODULE)});
        const database = new PipelineDatabase(process.argv[1]);
        process.stdout.write(database.getActiveUploadProvider());
        database.close();
    `, databasePath], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VIDEO_SITES_FILE: sitesFile } });
    const results = await Promise.all([open(), open(), open()].map(async (child) => {
        let output = "", stderr = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const [code] = await once(child, "exit");
        return { code, output, stderr };
    }));
    for (const result of results) assert.deepEqual({ code: result.code, output: result.output }, { code: 0, output: "form-host" }, result.stderr);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    t.after(() => database.close());
    assert.equal(database.prepare("SELECT count(*) AS n FROM schema_version").get().n, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM campaign_control").get().n, 1);
});

test("an older schema is refused and left untouched", async (t) => {
    const { databasePath } = await ledger(t);
    const raw = new DatabaseSync(databasePath);
    raw.exec("UPDATE schema_version SET version = 16");
    raw.close();
    const before = contents(databasePath);
    assert.throws(() => new PipelineDatabase(databasePath), /schema 16: this release opens schema 17 only/);
    assert.deepEqual(contents(databasePath), before);
});

test("the ledger refuses an upload destination that is not a destination ID", async (t) => {
    const { databasePath } = await ledger(t);
    const database = new DatabaseSync(databasePath);
    t.after(() => database.close());
    for (const bad of ["retired", "", "Form Host", "-x", "a".repeat(33)]) {
        assert.throws(() => database.prepare("UPDATE campaign_control SET upload_provider = ?").run(bad), /must be a destination ID/, bad);
    }
    database.exec("BEGIN; DELETE FROM campaign_control");
    assert.throws(() => database.exec("INSERT INTO campaign_control (id, state, provider_filter, ordering, monthly_upload_limit_bytes, updated_at, upload_provider) VALUES (1, 'paused', 'all', 'oldest', 1, 'at', 'Bad')"), /must be a destination ID/);
    database.exec("ROLLBACK");
    database.prepare("UPDATE campaign_control SET upload_provider = 'a'").run();
    database.prepare(`UPDATE campaign_control SET upload_provider = '${"b".repeat(32)}'`).run();
});

test("a retired destination never becomes active again, and retiring the active one keeps the ledger opening", async (t) => {
    const { databasePath } = await ledger(t);
    const raw = new DatabaseSync(databasePath);
    raw.exec(`INSERT INTO retired_destination_audit VALUES ('old-host', '2026-01-01T00:00:00.000Z', '{}');
        INSERT INTO destinations VALUES ('old-host', 'retired', 'old-host', '2026-01-01T00:00:00.000Z')`);
    assert.throws(() => raw.prepare("UPDATE campaign_control SET upload_provider = 'old-host'").run(), /retired upload destination cannot become active again/);
    raw.exec("INSERT INTO destinations VALUES ('form-host', 'retired', NULL, '2026-02-01T00:00:00.000Z')");
    raw.close();
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    assert.equal(database.getActiveUploadProvider(), "form-host");
    assert.throws(() => database.setActiveUploadProvider("old-host"), /retired/);
});
