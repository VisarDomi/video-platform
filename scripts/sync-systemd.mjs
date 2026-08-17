#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repositoryRoot, "systemd", "user");
const managedFiles = [
    "video-auth.service",
    "video-downloader.service",
    "video-pipeline.service",
    "video-processing.slice",
    "video-server.service",
    "video-xvfb.service",
    path.join("video-pipeline.service.d", "resources.conf"),
    path.join("video-server.service.d", "resources.conf"),
];

function usage() {
    throw new Error("Usage: node scripts/sync-systemd.mjs <--check|--apply> [--home ABSOLUTE_PATH]");
}

const arguments_ = process.argv.slice(2);
const mode = arguments_.shift();
if (!["--check", "--apply"].includes(mode ?? "")) usage();
let homeDirectory = os.homedir();
if (arguments_.length > 0) {
    if (arguments_.length !== 2 || arguments_[0] !== "--home") usage();
    homeDirectory = path.resolve(arguments_[1]);
    if (!path.isAbsolute(arguments_[1]) || homeDirectory === path.parse(homeDirectory).root) {
        throw new Error("--home must be an absolute non-root directory");
    }
}
const targetRoot = path.join(homeDirectory, ".config", "systemd", "user");

function renderTemplate(content, relativePath) {
    const rendered = content.toString("utf8").replaceAll("{{HOME}}", homeDirectory);
    const unresolved = rendered.match(/\{\{[A-Z][A-Z0-9_]*\}\}/g);
    if (unresolved) {
        throw new Error(`${relativePath} has unresolved parameters: ${[...new Set(unresolved)].join(", ")}`);
    }
    return Buffer.from(rendered);
}

async function readIfPresent(filePath) {
    try {
        return await fs.readFile(filePath);
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

async function installAtomic(content, targetPath) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporaryPath, content, { mode: 0o644 });
        await fs.rename(temporaryPath, targetPath);
    } finally {
        await fs.unlink(temporaryPath).catch(() => undefined);
    }
}

const mismatches = [];
for (const relativePath of managedFiles) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    const [sourceTemplate, target] = await Promise.all([
        fs.readFile(sourcePath),
        readIfPresent(targetPath),
    ]);
    const source = renderTemplate(sourceTemplate, relativePath);
    if (target === null || !source.equals(target)) mismatches.push(relativePath);
}

if (mode === "--check") {
    if (mismatches.length === 0) {
        console.log("Installed video-platform systemd configuration matches the repository.");
    } else {
        console.error(`Systemd configuration differs: ${mismatches.join(", ")}`);
        process.exitCode = 1;
    }
} else {
    for (const relativePath of mismatches) {
        const sourceTemplate = await fs.readFile(path.join(sourceRoot, relativePath));
        await installAtomic(
            renderTemplate(sourceTemplate, relativePath),
            path.join(targetRoot, relativePath),
        );
        console.log(`Installed ${relativePath}`);
    }
    const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    if (reload.error) throw reload.error;
    if (reload.status !== 0) throw new Error(`systemctl --user daemon-reload exited with ${reload.status}`);
    console.log("Reloaded the user systemd manager; no services were restarted.");
}
