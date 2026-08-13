import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FINALIZATION_DB_PATH, getProviderPaths } from "../core/config.js";
import { FinalizationCheckpointStore } from "../services/hls/finalizationCheckpointStore.js";
import { processFinalizedRecording } from "../services/hls/finalizedRecordingProcessor.js";
import {
    resolveManagedRecordingTarget,
    type HistoricalFinalizationTarget,
    type ManagedRecordingRoot,
} from "./finalizeLibraryTarget.js";

const PROVIDERS = ["tango", "fc2", "sc"] as const;
const SCOPES = ["downloads", "edited"] as const;
const CONTRACT_KEY = "historical-finalization-v1";

interface Options {
    provider: string;
    scope: string;
    recording: string | null;
    concurrency: number;
    maxCpu: number;
    limit: number;
    apply: boolean;
    retryFailed: boolean;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
    return parsed;
}

function parseArgs(argv: readonly string[]): Options {
    const options: Options = {
        provider: "all",
        scope: "all",
        recording: null,
        concurrency: 4,
        maxCpu: 80,
        limit: Number.POSITIVE_INFINITY,
        apply: false,
        retryFailed: false,
    };
    let providerSpecified = false;
    let scopeSpecified = false;
    let limitSpecified = false;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === "--apply") options.apply = true;
        else if (argument === "--dry-run") options.apply = false;
        else if (argument === "--retry-failed") options.retryFailed = true;
        else if (argument === "--provider") {
            providerSpecified = true;
            options.provider = argv[++index] ?? "";
        } else if (argument === "--scope") {
            scopeSpecified = true;
            options.scope = argv[++index] ?? "";
        } else if (argument === "--recording") {
            options.recording = argv[++index] ?? "";
            if (options.recording === "") throw new Error("--recording requires a directory path");
        } else if (argument === "--concurrency") options.concurrency = parsePositiveInteger(argv[++index], argument);
        else if (argument === "--limit") {
            limitSpecified = true;
            options.limit = parsePositiveInteger(argv[++index], argument);
        } else if (argument === "--max-cpu") {
            options.maxCpu = Number.parseFloat(argv[++index] ?? "");
            if (!(options.maxCpu > 0 && options.maxCpu <= 100)) throw new Error("--max-cpu must be in (0, 100]");
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (![...PROVIDERS, "all"].includes(options.provider as typeof PROVIDERS[number] | "all")) {
        throw new Error("--provider must be tango, fc2, sc, or all");
    }
    if (![...SCOPES, "all"].includes(options.scope as typeof SCOPES[number] | "all")) {
        throw new Error("--scope must be downloads, edited, or all");
    }
    if (options.recording !== null && (providerSpecified || scopeSpecified || limitSpecified)) {
        throw new Error("--recording cannot be combined with --provider, --scope, or --limit");
    }
    return options;
}

function managedRoots(): ManagedRecordingRoot[] {
    return PROVIDERS.flatMap((provider) => {
        const paths = getProviderPaths(provider);
        return [
            { provider, scope: "downloads", rootPath: paths.downloader },
            { provider, scope: "edited", rootPath: paths.edited },
        ];
    });
}

async function discoverTargets(options: Options): Promise<HistoricalFinalizationTarget[]> {
    if (options.recording !== null) {
        return [await resolveManagedRecordingTarget(options.recording, managedRoots())];
    }

    const providers = options.provider === "all" ? PROVIDERS : [options.provider];
    const scopes = options.scope === "all" ? SCOPES : [options.scope];
    const targets: HistoricalFinalizationTarget[] = [];
    for (const provider of providers) {
        const providerPaths = getProviderPaths(provider);
        for (const scope of scopes) {
            const root = scope === "downloads" ? providerPaths.downloader : providerPaths.edited;
            let entries;
            try {
                entries = await fs.readdir(root, { withFileTypes: true });
            } catch (error: any) {
                if (error?.code === "ENOENT") continue;
                throw error;
            }
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
                targets.push({ provider, scope, recordingPath: path.join(root, entry.name) });
            }
        }
    }
    return targets.sort((left, right) => left.recordingPath.localeCompare(right.recordingPath));
}

function readCpuCounters(): { idle: number; total: number } {
    return os.cpus().reduce((result, cpu) => {
        result.idle += cpu.times.idle;
        result.total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
        return result;
    }, { idle: 0, total: 0 });
}

function createCpuGuard(maxCpu: number) {
    let previous = readCpuCounters();
    let current = 0;
    let peak = 0;
    const interval = setInterval(() => {
        const next = readCpuCounters();
        const totalDelta = next.total - previous.total;
        const idleDelta = next.idle - previous.idle;
        previous = next;
        if (totalDelta <= 0) return;
        current = 100 * (1 - idleDelta / totalDelta);
        peak = Math.max(peak, current);
    }, 500);
    return {
        async wait(): Promise<void> {
            while (current > maxCpu) await new Promise((resolve) => setTimeout(resolve, 500));
        },
        snapshot: () => ({ current, peak }),
        close: () => clearInterval(interval),
    };
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const singleRecordingCpuBudget = Math.max(1, Math.floor(os.cpus().length / 2));
    const ffmpegThreads = options.recording === null ? 1 : singleRecordingCpuBudget;
    const fmp4ScanConcurrency = options.recording === null ? 1 : singleRecordingCpuBudget;
    const discovered = await discoverTargets(options);
    const selected = discovered.slice(0, options.limit);
    console.log(JSON.stringify({
        event: "start",
        mode: options.apply ? "apply" : "dry-run",
        provider: options.provider,
        scope: options.scope,
        recording: options.recording,
        discovered: discovered.length,
        selected: selected.length,
        concurrency: options.concurrency,
        maxCpu: options.maxCpu,
        retryFailed: options.retryFailed,
        ffmpegThreads,
        fmp4ScanConcurrency,
        checkpointPath: FINALIZATION_DB_PATH,
    }));
    if (!options.apply) return;

    const checkpoints = new FinalizationCheckpointStore(FINALIZATION_DB_PATH);
    const cpu = createCpuGuard(options.maxCpu);
    const totals = { ready: 0, failed: 0, notFinalized: 0, sidecarsRemoved: 0 };
    let nextIndex = 0;
    const worker = async () => {
        while (true) {
            const position = nextIndex++;
            const target = selected[position];
            if (!target) return;
            const startedAt = Date.now();
            await cpu.wait();
            try {
                const result = await processFinalizedRecording(target.recordingPath, {
                    checkpointStore: checkpoints,
                    retryFailed: options.retryFailed,
                    ffmpegThreads,
                    fmp4ScanConcurrency,
                });
                let status: string;
                let error: string | null = null;
                if (result.kind === "not-finalized") {
                    totals.notFinalized++;
                    status = "not-finalized";
                } else if (result.report.status === "ready") {
                    totals.ready++;
                    status = "ready";
                    const sidecarPath = path.join(target.recordingPath, ".media-integrity.json");
                    try {
                        await fs.unlink(sidecarPath);
                        totals.sidecarsRemoved++;
                    } catch (unlinkError: any) {
                        if (unlinkError?.code !== "ENOENT") throw unlinkError;
                    }
                } else {
                    totals.failed++;
                    status = "failed";
                    error = result.report.error;
                }
                console.log(JSON.stringify({
                    event: "recording",
                    position: position + 1,
                    recordingPath: target.recordingPath,
                    status,
                    error,
                    elapsedSeconds: (Date.now() - startedAt) / 1000,
                    cpu: cpu.snapshot(),
                }));
            } catch (error: any) {
                totals.failed++;
                console.log(JSON.stringify({
                    event: "recording",
                    position: position + 1,
                    recordingPath: target.recordingPath,
                    status: "failed",
                    error: error?.message ?? String(error),
                    elapsedSeconds: (Date.now() - startedAt) / 1000,
                    cpu: cpu.snapshot(),
                }));
            }
        }
    };

    try {
        await Promise.all(Array.from({ length: Math.min(options.concurrency, selected.length) }, worker));
        const completeScope = options.provider === "all"
            && options.scope === "all"
            && options.recording === null
            && selected.length === discovered.length;
        if (completeScope && totals.failed === 0 && totals.notFinalized === 0) {
            checkpoints.setMeta(CONTRACT_KEY, {
                status: "complete",
                completedAt: new Date().toISOString(),
                recordingCount: totals.ready,
            });
        }
        console.log(JSON.stringify({
            event: "finished",
            ...totals,
            contractEstablished: completeScope && totals.failed === 0 && totals.notFinalized === 0,
            cpu: cpu.snapshot(),
        }));
        if (totals.failed > 0 || totals.notFinalized > 0) process.exitCode = 1;
    } finally {
        cpu.close();
        checkpoints.close();
    }
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
