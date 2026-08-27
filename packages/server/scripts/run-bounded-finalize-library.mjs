#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isSingleRecording = process.argv.slice(2).includes("--recording");
// A stable scope name makes the migration single-instance and gives the
// operator one predictable unit to stop, inspect, and restart.
const scopeName = isSingleRecording ? "video-finalize-library-single" : "video-finalize-library";
const arguments_ = [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--slice=video-processing.slice",
    `--unit=${scopeName}`,
    process.execPath,
    "--no-warnings",
    path.join(packageDirectory, "dist", "commands", "finalizeLibrary.js"),
    ...process.argv.slice(2),
];

const child = spawn("systemd-run", arguments_, { stdio: "inherit" });
child.on("error", (error) => {
    console.error(`Could not start bounded library finalization: ${error.message}`);
    process.exitCode = 1;
});
child.on("close", (code, signal) => {
    if (signal) {
        console.error(`Bounded library finalization ended from signal ${signal}`);
        process.exitCode = 1;
        return;
    }
    process.exitCode = code ?? 1;
});
