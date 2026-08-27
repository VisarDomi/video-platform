#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("systemd-run", [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--slice=video-processing.slice",
    "--unit=video-pipeline-describe-one",
    process.execPath,
    "--no-warnings",
    path.join(packageDirectory, "dist", "main.js"),
    "describe-one",
    ...process.argv.slice(2),
], { stdio: "inherit" });

child.on("error", (error) => {
    console.error(`Could not start bounded pipeline descriptor scope: ${error.message}`);
    process.exitCode = 1;
});
child.on("close", (code, signal) => {
    process.exitCode = signal ? 1 : code ?? 1;
});
