import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("server config import does not create provider storage directories", async (t) => {
    const temporaryHome = await mkdtemp(path.join(tmpdir(), "video-server-home-"));
    t.after(() => rm(temporaryHome, { recursive: true }));

    await execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        `const config = await import(${JSON.stringify(new URL("../dist/core/config.js", import.meta.url).href)}); if (JSON.stringify(config.getAllProviders()) !== JSON.stringify(["tango", "fc2", "sc"])) process.exit(2);`,
    ], {
        env: { ...process.env, HOME: temporaryHome },
    });

    await assert.rejects(
        stat(path.join(temporaryHome, "Videos", "downloads")),
        { code: "ENOENT" },
    );
});
