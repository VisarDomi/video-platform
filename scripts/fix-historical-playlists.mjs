#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repairPlaylistDurations } from "../packages/server/dist/services/hls/playlistAuthority.js";

const DEFAULT_DOWNLOADS_ROOT = "/home/visar/Videos/downloads";
const LIVE_STATUS_PATH = "/home/visar/.local/share/video-services/live-status.json";
const DEFAULT_CHECKPOINT_PATH = "/home/visar/.local/share/video-services/fix-playlists.sqlite";
const PROVIDERS = ["tango", "fc2"];
const SCOPES = ["downloads", "edited"];
const RULE_VERSION = "media-timeline-v2";

function usage() {
    console.log(`Usage:
  node scripts/fix-historical-playlists.mjs [options]

Options:
  --provider tango|fc2|all  Provider to scan (default: all)
  --scope downloads|edited|all
                            Storage scope to scan (default: downloads)
  --limit N                 Process at most N playlists
  --offset N                Skip the first N discovered playlists (default: 0)
  --concurrency N           Concurrent segment byte/media probes (default: 1)
  --max-cpu N               Pause new probes above N% system CPU (default: 80)
  --downloads-root PATH     Override the downloads root (testing only)
  --checkpoint PATH         SQLite checkpoint path
                            (default: ${DEFAULT_CHECKPOINT_PATH})
  --no-resume               Ignore prior checkpoints for this run
  --apply                   Atomically rewrite changed playlists
  --dry-run                 Report changes without writing (default)
  --help                    Show this help

The script skips exact folders currently present in live-status.json. It uses
the server's canonical MPEG-TS PTS timeline repair, falls back to the longest
audio/video stream only at boundaries that need it, and skips fMP4 playlists.
It is idempotent: an already-correct playlist reports unchanged.`);
}

function parsePositiveInteger(value, name, minimum = 1) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < minimum) {
        throw new Error(`${name} must be an integer >= ${minimum}`);
    }
    return parsed;
}

function parseArgs(argv) {
    const options = {
        provider: "all",
        scope: "downloads",
        limit: Number.POSITIVE_INFINITY,
        offset: 0,
        concurrency: 1,
        maxCpu: 80,
        downloadsRoot: DEFAULT_DOWNLOADS_ROOT,
        checkpointPath: DEFAULT_CHECKPOINT_PATH,
        resume: true,
        apply: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--help") {
            usage();
            process.exit(0);
        } else if (arg === "--apply") {
            options.apply = true;
        } else if (arg === "--dry-run") {
            options.apply = false;
        } else if (arg === "--provider") {
            options.provider = argv[++index];
        } else if (arg === "--scope") {
            options.scope = argv[++index];
        } else if (arg === "--limit") {
            options.limit = parsePositiveInteger(argv[++index], "--limit");
        } else if (arg === "--offset") {
            options.offset = parsePositiveInteger(argv[++index], "--offset", 0);
        } else if (arg === "--concurrency") {
            options.concurrency = parsePositiveInteger(argv[++index], "--concurrency");
        } else if (arg === "--max-cpu") {
            options.maxCpu = Number.parseFloat(argv[++index]);
            if (!(options.maxCpu > 0 && options.maxCpu <= 100)) {
                throw new Error("--max-cpu must be greater than 0 and at most 100");
            }
        } else if (arg === "--downloads-root") {
            options.downloadsRoot = path.resolve(argv[++index]);
        } else if (arg === "--checkpoint") {
            options.checkpointPath = path.resolve(argv[++index]);
        } else if (arg === "--no-resume") {
            options.resume = false;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (![...PROVIDERS, "all"].includes(options.provider)) {
        throw new Error("--provider must be tango, fc2, or all");
    }
    if (![...SCOPES, "all"].includes(options.scope)) {
        throw new Error("--scope must be downloads, edited, or all");
    }
    return options;
}

class CheckpointStore {
    constructor(databasePath, mode) {
        this.mode = mode;
        this.database = new DatabaseSync(databasePath);
        this.database.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            CREATE TABLE IF NOT EXISTS completed_playlists (
                mode TEXT NOT NULL,
                rule_version TEXT NOT NULL,
                playlist_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime_ms INTEGER NOT NULL,
                result_status TEXT NOT NULL,
                completed_at TEXT NOT NULL,
                PRIMARY KEY (mode, rule_version, playlist_path)
            );
        `);
        this.findStatement = this.database.prepare(`
            SELECT size, mtime_ms
            FROM completed_playlists
            WHERE mode = ? AND rule_version = ? AND playlist_path = ?
        `);
        this.saveStatement = this.database.prepare(`
            INSERT INTO completed_playlists (
                mode, rule_version, playlist_path, size, mtime_ms,
                result_status, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mode, rule_version, playlist_path) DO UPDATE SET
                size = excluded.size,
                mtime_ms = excluded.mtime_ms,
                result_status = excluded.result_status,
                completed_at = excluded.completed_at
        `);
    }

    isComplete(playlistPath, fingerprint) {
        const row = this.findStatement.get(this.mode, RULE_VERSION, playlistPath);
        return row !== undefined
            && row.size === fingerprint.size
            && row.mtime_ms === fingerprint.mtimeMs;
    }

    markComplete(playlistPath, fingerprint, status) {
        this.saveStatement.run(
            this.mode,
            RULE_VERSION,
            playlistPath,
            fingerprint.size,
            fingerprint.mtimeMs,
            status,
            new Date().toISOString(),
        );
    }

    close() {
        this.database.close();
    }
}

async function playlistFingerprint(playlistPath) {
    const stat = await fs.stat(playlistPath);
    return {
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
    };
}

async function discoverPlaylists(provider, scope, downloadsRoot) {
    const providers = provider === "all" ? PROVIDERS : [provider];
    const scopes = scope === "all" ? SCOPES : [scope];
    const playlists = [];
    for (const currentProvider of providers) {
        for (const currentScope of scopes) {
            const root = currentScope === "downloads"
                ? path.join(downloadsRoot, currentProvider, "downloader")
                : path.join(downloadsRoot, currentProvider, "editor", "edited");
            let entries;
            try {
                entries = await fs.readdir(root, { withFileTypes: true });
            } catch (error) {
                if (error.code === "ENOENT") continue;
                throw error;
            }
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const playlistPath = path.join(root, entry.name, "playlist.m3u8");
                try {
                    await fs.access(playlistPath);
                    playlists.push({ provider: currentProvider, scope: currentScope, playlistPath });
                } catch {
                    // A folder without a playlist is not a migration target.
                }
            }
        }
    }
    return playlists.sort((left, right) => left.playlistPath.localeCompare(right.playlistPath));
}

async function readActiveDirectories() {
    try {
        const status = JSON.parse(await fs.readFile(LIVE_STATUS_PATH, "utf8"));
        return new Set(
            Array.isArray(status.downloads)
                ? status.downloads
                    .map((download) => download?.segmentsDirPath)
                    .filter((value) => typeof value === "string")
                    .map((value) => path.resolve(value))
                : [],
        );
    } catch (error) {
        throw new Error(`Cannot safely read ${LIVE_STATUS_PATH}: ${error.message}`);
    }
}

function readCpuCounters() {
    const totals = os.cpus().reduce(
        (result, cpu) => {
            const times = cpu.times;
            result.idle += times.idle;
            result.total += times.user + times.nice + times.sys + times.idle + times.irq;
            return result;
        },
        { idle: 0, total: 0 },
    );
    return totals;
}

function createCpuGuard(maxCpu) {
    let previous = readCpuCounters();
    let currentUsage = 0;
    let peakUsage = 0;
    let sumUsage = 0;
    let sampleCount = 0;

    const interval = setInterval(() => {
        const next = readCpuCounters();
        const totalDelta = next.total - previous.total;
        const idleDelta = next.idle - previous.idle;
        previous = next;
        if (totalDelta <= 0) return;
        currentUsage = 100 * (1 - idleDelta / totalDelta);
        peakUsage = Math.max(peakUsage, currentUsage);
        sumUsage += currentUsage;
        sampleCount += 1;
    }, 500);

    return {
        async waitForCapacity() {
            while (currentUsage > maxCpu) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        },
        snapshot() {
            return {
                current: currentUsage,
                peak: peakUsage,
                average: sampleCount === 0 ? 0 : sumUsage / sampleCount,
            };
        },
        stop() {
            clearInterval(interval);
            return this.snapshot();
        },
    };
}

async function repairPlaylist(target, options, cpuGuard) {
    const directory = path.dirname(target.playlistPath);
    const activeDirectories = await readActiveDirectories();
    if (activeDirectories.has(path.resolve(directory))) {
        return { status: "live", segmentCount: 0 };
    }

    const summary = await repairPlaylistDurations(directory, {
        apply: options.apply,
        probeConcurrency: options.concurrency,
        beforeProbe: () => cpuGuard.waitForCapacity(),
        beforeWrite: async () => {
            const activeBeforeWrite = await readActiveDirectories();
            return !activeBeforeWrite.has(path.resolve(directory));
        },
    });

    if (summary.writeSkippedReason === "write-guard") {
        return { status: "live", segmentCount: summary.segmentCount };
    }

    return {
        status: summary.skipped
            ? "skipped"
            : summary.playlistChanged
                ? (summary.wrotePlaylist ? "written" : "would-change")
                : "unchanged",
        segmentCount: summary.segmentCount,
        changedDurationCount: summary.changedDurationCount,
        targetChanged: summary.targetDurationBefore !== summary.targetDurationAfter,
        totalBefore: summary.totalDurationBefore,
        totalAfter: summary.totalDurationAfter,
        delta: summary.totalDurationDelta,
        byteProbeCount: summary.byteProbeCount,
        ffprobeProbeCount: summary.ffprobeProbeCount,
        failedProbeCount: summary.failedProbeCount,
        skipReason: summary.skipReason,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    await fs.mkdir(path.dirname(options.checkpointPath), { recursive: true });
    const mode = options.apply ? "apply" : "dry-run";
    const checkpoints = new CheckpointStore(options.checkpointPath, mode);
    const discovered = await discoverPlaylists(options.provider, options.scope, options.downloadsRoot);
    const selected = discovered.slice(options.offset, options.offset + options.limit);
    const cpuGuard = createCpuGuard(options.maxCpu);
    const startedAt = Date.now();
    const totals = {
        processed: 0,
        unchanged: 0,
        changed: 0,
        written: 0,
        live: 0,
        failed: 0,
        segments: 0,
        durationDelta: 0,
        checkpointSkipped: 0,
    };

    console.log(JSON.stringify({
        event: "start",
        mode,
        ruleVersion: RULE_VERSION,
        provider: options.provider,
        scope: options.scope,
        discovered: discovered.length,
        selected: selected.length,
        offset: options.offset,
        concurrency: options.concurrency,
        maxCpu: options.maxCpu,
        resume: options.resume,
        checkpointPath: options.checkpointPath,
        downloadsRoot: options.downloadsRoot,
    }));

    for (let index = 0; index < selected.length; index += 1) {
        const target = selected[index];
        const itemStartedAt = Date.now();
        try {
            const fingerprintBefore = await playlistFingerprint(target.playlistPath);
            if (options.resume && checkpoints.isComplete(target.playlistPath, fingerprintBefore)) {
                totals.checkpointSkipped += 1;
                console.log(JSON.stringify({
                    event: "playlist",
                    position: index + 1,
                    playlistPath: target.playlistPath,
                    elapsedSeconds: 0,
                    status: "checkpoint",
                }));
                continue;
            }
            const result = await repairPlaylist(target, options, cpuGuard);
            totals.processed += 1;
            totals.segments += result.segmentCount ?? 0;
            totals.durationDelta += result.delta ?? 0;
            if (result.status === "unchanged") totals.unchanged += 1;
            if (result.status === "would-change") totals.changed += 1;
            if (result.status === "written") {
                totals.changed += 1;
                totals.written += 1;
            }
            if (result.status === "live") totals.live += 1;
            if (result.status !== "live" && result.status !== "empty") {
                const fingerprintAfter = await playlistFingerprint(target.playlistPath);
                checkpoints.markComplete(target.playlistPath, fingerprintAfter, result.status);
            }
            console.log(JSON.stringify({
                event: "playlist",
                position: index + 1,
                playlistPath: target.playlistPath,
                elapsedSeconds: (Date.now() - itemStartedAt) / 1000,
                cpu: cpuGuard.snapshot(),
                ...result,
            }));
        } catch (error) {
            totals.failed += 1;
            console.error(JSON.stringify({
                event: "failure",
                position: index + 1,
                playlistPath: target.playlistPath,
                elapsedSeconds: (Date.now() - itemStartedAt) / 1000,
                error: error.message,
            }));
        }
    }

    const cpu = cpuGuard.stop();
    checkpoints.close();
    console.log(JSON.stringify({
        event: "finished",
        elapsedSeconds: (Date.now() - startedAt) / 1000,
        cpu,
        ...totals,
    }));
    if (totals.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
