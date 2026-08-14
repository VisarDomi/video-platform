#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cpuQuotaPercent = Math.max(100, os.cpus().length * 50);
const arguments_ = [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--slice=video-processing.slice",
    "--unit=video-pipeline-remux-one",
    "--property=CPUWeight=100",
    "--property=MemoryHigh=70%",
    "--property=MemoryMax=80%",
    "--property=MemorySwapMax=0",
    `--property=CPUQuota=${cpuQuotaPercent}%`,
    process.execPath,
    "--no-warnings",
    path.join(packageDirectory, "dist", "main.js"),
    "remux-one",
    ...process.argv.slice(2),
];

const child = spawn("systemd-run", arguments_, { stdio: "inherit" });
child.on("error", (error) => {
    console.error(`Could not start bounded single-recording remux: ${error.message}`);
    process.exitCode = 1;
});
child.on("close", (code, signal) => {
    process.exitCode = signal ? 1 : code ?? 1;
});
