#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const input = process.argv[2];
if (!input) {
    throw new Error("Usage: npm run smoke:bounded -w descriptor -- <remuxed-video-file>");
}

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cpuQuotaPercent = Math.max(100, os.cpus().length * 80);
const scopeName = `video-descriptor-smoke-${process.pid}`;
const arguments_ = [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--unit=${scopeName}`,
    "--property=MemoryHigh=70%",
    "--property=MemoryMax=80%",
    "--property=MemorySwapMax=0",
    `--property=CPUQuota=${cpuQuotaPercent}%`,
    process.execPath,
    path.join(packageDirectory, "dist", "smoke.js"),
    path.resolve(input),
];

const child = spawn("systemd-run", arguments_, { stdio: "inherit" });
child.on("error", (error) => {
    console.error(`Could not start bounded descriptor scope: ${error.message}`);
    process.exitCode = 1;
});
child.on("close", (code, signal) => {
    if (signal) {
        console.error(`Bounded descriptor scope ended from signal ${signal}`);
        process.exitCode = 1;
        return;
    }
    process.exitCode = code ?? 1;
});
