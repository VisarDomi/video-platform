import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

// Changed on purpose: the providers are no longer a constant of the config module but the
// capture sites of the sites file, configured at startup. Importing the config knows none;
// configuring them still creates no storage directory.
test("server config import does not create provider storage directories", async (t) => {
    const temporaryHome = await mkdtemp(path.join(tmpdir(), "video-server-home-"));
    t.after(() => rm(temporaryHome, { recursive: true }));

    await execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        `const config = await import(${JSON.stringify(new URL("../dist/core/config.js", import.meta.url).href)}); if (JSON.stringify(config.getAllProviders()) !== "[]") process.exit(3); config.configureProviders(["live-a", "live-b", "live-c"]); if (JSON.stringify(config.getAllProviders()) !== JSON.stringify(["live-a", "live-b", "live-c"]) || config.defaultProvider() !== "live-a" || !config.getProviderPaths("live-c").downloaded.endsWith("/Videos/downloads/live-c/downloaded")) process.exit(2);`,
    ], {
        env: { ...process.env, HOME: temporaryHome },
    });

    await assert.rejects(
        stat(path.join(temporaryHome, "Videos", "downloads")),
        { code: "ENOENT" },
    );
});
