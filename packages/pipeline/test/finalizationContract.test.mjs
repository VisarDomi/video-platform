import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { readFinalizationContract } from "../dist/discovery/finalizationContract.js";

test("pipeline trust remains disabled until the all-library server contract is complete", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "finalization-contract-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const databasePath = path.join(root, "finalization.sqlite");
    assert.equal(readFinalizationContract(databasePath), null);

    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE finalization_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT");
    database.prepare("INSERT INTO finalization_meta VALUES (?, ?, ?)").run(
        "historical-finalization-v1",
        JSON.stringify({ status: "complete", completedAt: "2026-08-12T10:00:00Z", recordingCount: 3429 }),
        "2026-08-12T10:00:00Z",
    );
    database.close();

    assert.deepEqual(readFinalizationContract(databasePath), {
        status: "complete",
        completedAt: "2026-08-12T10:00:00Z",
        recordingCount: 3429,
    });
});
