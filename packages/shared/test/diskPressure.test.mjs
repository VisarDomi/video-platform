import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diskPressureSummary } from "../dist/index.js";

test("a slow write's warning carries the I/O pressure and the page cache waiting to be written", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "disk-pressure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "pressure"));
    await writeFile(path.join(root, "pressure", "io"), "some avg10=41.20 avg60=12.00 avg300=3.00 total=1\nfull avg10=30.05 avg60=9.00 avg300=2.00 total=1\n");
    await writeFile(path.join(root, "meminfo"), "MemTotal:       32000000 kB\nDirty:           1048576 kB\nWriteback:         20480 kB\n");
    assert.equal(await diskPressureSummary(root), "iosome10=41.20% iofull10=30.05% dirty=1024MB writeback=20MB");
    assert.equal(await diskPressureSummary(path.join(root, "missing")), "");
});
