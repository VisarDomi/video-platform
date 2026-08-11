import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const lockPath = path.join(packageDirectory, "runtime", "llama-cpp.lock.json");
export const dataRoot = process.env.VIDEO_SERVICES_DATA_ROOT
    ?? path.join(os.homedir(), ".local", "share", "video-services");
export const runtimeRoot = path.join(dataRoot, "runtimes", "llama-cpp");

export async function readLock() {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
}

export function capture(command, args, options = {}) {
    return execFileSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

export function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${result.status}`);
    }
}

export async function activateRuntime(runtimeId) {
    if (!/^[a-zA-Z0-9._-]+$/.test(runtimeId)) {
        throw new Error(`Invalid runtime id: ${runtimeId}`);
    }

    const target = path.join(runtimeRoot, runtimeId);
    await fs.access(path.join(target, "manifest.json"));
    await fs.access(path.join(target, "bin", "llama-server"));
    await fs.mkdir(runtimeRoot, { recursive: true });

    const temporaryLink = path.join(runtimeRoot, `.current-${randomUUID()}`);
    await fs.symlink(runtimeId, temporaryLink);
    await fs.rename(temporaryLink, path.join(runtimeRoot, "current"));
    return target;
}

export function dirtyFingerprint(sourceDirectory) {
    const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
        cwd: sourceDirectory,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return createHash("sha256").update(diff).digest("hex").slice(0, 12);
}
