#!/usr/bin/env node
// Builds every workspace in the given folders, in order, skipping folders that are not
// there (a public clone has no private/): `node scripts/build-workspaces.mjs plugins profiles`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const folder of process.argv.slice(2)) {
    const directory = path.join(root, folder);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
        const manifest = path.join(directory, entry, "package.json");
        if (!existsSync(manifest) || !JSON.parse(readFileSync(manifest, "utf8")).scripts?.build) continue;
        const result = spawnSync("npm", ["run", "build", "-w", path.join(folder, entry)], { cwd: root, stdio: "inherit" });
        if (result.error) throw result.error;
        if (result.status !== 0) process.exit(result.status ?? 1);
    }
}
