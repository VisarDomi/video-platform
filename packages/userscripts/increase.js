import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const packagePath = resolve(packageRoot, "package.json");
const lockPath = resolve(packageRoot, "..", "..", "package-lock.json");
const workspacePath = "packages/userscripts";

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const currentVersion = Number.parseInt(pkg.version, 10);
if (!Number.isSafeInteger(currentVersion)) {
    throw new Error(`Invalid integer userscript version: ${pkg.version}`);
}

const nextVersion = String(currentVersion + 1);
pkg.version = nextVersion;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 4)}\n`, "utf8");

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const workspace = lock.packages?.[workspacePath];
if (!workspace) {
    throw new Error(`Missing ${workspacePath} entry in package-lock.json`);
}
workspace.version = nextVersion;
writeFileSync(lockPath, `${JSON.stringify(lock, null, 4)}\n`, "utf8");

console.log(`Userscript version incremented: ${currentVersion} -> ${nextVersion}`);
