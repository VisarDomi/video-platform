#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { repairFailedMediaIntegrity } from "../packages/server/dist/services/hls/failedIntegrityRepair.js";

const apply = process.argv.includes("--apply");
const streamArgument = process.argv.slice(2).find((argument) => argument !== "--apply");
if (!streamArgument) {
    throw new Error("Usage: npm run repair-failed-integrity -- [--apply] /absolute/recording/path");
}
const streamPath = path.resolve(streamArgument);
if (!apply) {
    const report = JSON.parse(await readFile(path.join(streamPath, ".media-integrity.json"), "utf8"));
    console.log(JSON.stringify({
        mode: "dry-run",
        streamPath,
        status: report.status,
        invalidSegments: report.invalidSegments ?? [],
        note: "Pass --apply to remove playlist entries, add discontinuities, move exact files to desktop Trash, repair durations, and revalidate.",
    }, null, 2));
} else {
    console.log(JSON.stringify(await repairFailedMediaIntegrity(streamPath), null, 2));
}
