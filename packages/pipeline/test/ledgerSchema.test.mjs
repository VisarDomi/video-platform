// The ledger's schema: a new ledger is created whole, in one transaction, with the sites
// file's first destination; opening an existing one changes nothing and takes no write
// lock; the database itself refuses a bad or retired destination; an older schema is
// refused untouched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
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

test("a schema other than this one and the one before is refused and left untouched", async (t) => {
    for (const version of [17, 20]) {
        const { databasePath } = await ledger(t);
        const raw = new DatabaseSync(databasePath);
        raw.exec(`UPDATE schema_version SET version = ${version}`);
        raw.close();
        const before = contents(databasePath);
        assert.throws(() => new PipelineDatabase(databasePath), new RegExp(`schema ${version}: this release opens schema 19 and upgrades schema 18 only`));
        assert.deepEqual(contents(databasePath), before);
    }
});

// A schema-18 ledger as the release before this one created it, with an upload history.
const SCHEMA_18 = readFileSync(new URL("./fixtures/ledger-schema-18.sql", import.meta.url), "utf8");
async function ledger18(t) {
    const { directory, databasePath, sitesFile } = await setting(t);
    const raw = new DatabaseSync(databasePath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(SCHEMA_18);
    raw.exec(`
        INSERT INTO schema_version VALUES (18);
        INSERT INTO campaign_control (id, state, provider_filter, ordering, daily_upload_limit_bytes, updated_at, upload_provider)
            VALUES (1, 'running', 'all', 'oldest', 25000000000, '2026-11-01T00:00:00.000Z', 'form-host');
        INSERT INTO production_version VALUES (1, 'production-v6', '2026-01-01T00:00:00.000Z');
        INSERT INTO recordings (id, provider, source_kind, source_path, playlist_path, source_fingerprint, duration_seconds,
            state, created_at, updated_at) VALUES ('r1', 'live-a', 'edited', '/x/2026-01-01 010000 a', '/x/p.m3u8', 'f', 60,
            'upload_uncertain', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
        INSERT INTO upload_reservations (id, recording_id, artifact_part, provider, calendar_month, reserved_bytes, status,
            created_at, updated_at, uplink) VALUES ('res1', 'r1', 'full', 'form-host', '2026-11', 1000, 'released', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'home');
        INSERT INTO upload_attempts (id, reservation_id, recording_id, provider, status, started_at, uplink)
            VALUES ('att1', 'res1', 'r1', 'form-host', 'uncertain', '2026-11-02T00:00:00.000Z', 'home');
        INSERT INTO bandwidth_events (recording_id, attempt_id, provider, calendar_month, transmitted_bytes, created_at, uplink)
            VALUES ('r1', 'att1', 'form-host', '2026-11', 900, '2026-11-02T00:00:00.000Z', 'home');
    `);
    raw.close();
    return { directory, databasePath, sitesFile };
}

// The schema as SQLite describes it: every table's columns, indexes, triggers and checks,
// with the stored SQL compared without layout.
function schema(databasePath) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        const flat = (sql) => sql?.replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim() ?? null;
        return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
            .map(({ type, name, tbl_name: table, sql }) => ({ type, name, table, sql: flat(sql),
                columns: type === "table" ? database.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_xinfo('${name}')`).all().map((row) => ({ ...row })) : undefined }));
    } finally { database.close(); }
}

test("a schema-18 ledger is upgraded to the same schema a new ledger has, keeping its history", async (t) => {
    const fresh = await setting(t);
    new PipelineDatabase(fresh.databasePath).close();
    const { databasePath } = await ledger18(t);
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    assert.deepEqual(schema(databasePath), schema(fresh.databasePath));
    assert.equal(database.integrityCheck(), "ok");
    const control = database.getCampaignControl();
    assert.deepEqual([control.state, control.dailyUploadLimitBytes], ["running", 25_000_000_000]);
    assert.deepEqual(database.uploadUsage("2026-11", "home"), { spent: 900, reserved: 0 });
    assert.deepEqual(database.uploadUsage("2026-11", "office"), { spent: 0, reserved: 0 });
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    t.after(() => raw.close());
    assert.equal(raw.prepare("SELECT uplink FROM upload_attempts WHERE id = 'att1'").get().uplink, "home");
    assert.equal(raw.prepare("SELECT uplink FROM upload_reservations WHERE id = 'res1'").get().uplink, "home");
    assert.equal(raw.prepare("SELECT version FROM schema_version").get().version, 19);
    // Opening the upgraded ledger again changes nothing.
    const before = contents(databasePath);
    new PipelineDatabase(databasePath).close();
    assert.deepEqual(contents(databasePath), before);
});

test("SIGKILL in the middle of the upgrade leaves the schema-18 ledger; the next open upgrades it whole", async (t) => {
    const { databasePath, sitesFile } = await ledger18(t);
    const before = contents(databasePath);
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
        import { writeSync } from "node:fs";
        import { DatabaseSync } from "node:sqlite";
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function (sql) {
            if (sql.includes("UPDATE schema_version")) {
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
    assert.deepEqual(contents(databasePath), before, "the killed upgrade left the old ledger as it was");
    const database = new PipelineDatabase(databasePath);
    t.after(() => database.close());
    assert.equal(database.getCampaignControl().dailyUploadLimitBytes, 25_000_000_000);
    assert.equal(database.integrityCheck(), "ok");
});

test("two processes opening a schema-18 ledger at once upgrade it once", async (t) => {
    const { databasePath, sitesFile } = await ledger18(t);
    const open = () => spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
        const { PipelineDatabase } = await import(${JSON.stringify(MODULE)});
        const database = new PipelineDatabase(process.argv[1]);
        process.stdout.write(String(database.getCampaignControl().dailyUploadLimitBytes));
        database.close();
    `, databasePath], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VIDEO_SITES_FILE: sitesFile } });
    const results = await Promise.all([open(), open(), open()].map(async (child) => {
        let output = "", stderr = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const [code] = await once(child, "exit");
        return { code, output, stderr };
    }));
    for (const result of results) assert.deepEqual({ code: result.code, output: result.output }, { code: 0, output: "25000000000" }, result.stderr);
});

test("the ledger refuses an upload destination that is not a destination ID", async (t) => {
    const { databasePath } = await ledger(t);
    const database = new DatabaseSync(databasePath);
    t.after(() => database.close());
    for (const bad of ["retired", "", "Form Host", "-x", "a".repeat(33)]) {
        assert.throws(() => database.prepare("UPDATE campaign_control SET upload_provider = ?").run(bad), /must be a destination ID/, bad);
    }
    database.exec("BEGIN; DELETE FROM campaign_control");
    assert.throws(() => database.exec("INSERT INTO campaign_control (id, state, provider_filter, ordering, daily_upload_limit_bytes, updated_at, upload_provider) VALUES (1, 'paused', 'all', 'oldest', 1, 'at', 'Bad')"), /must be a destination ID/);
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
