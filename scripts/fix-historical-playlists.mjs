#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DOWNLOADS_ROOT = "/home/visar/Videos/downloads";
const LIVE_STATUS_PATH = "/home/visar/.local/share/video-services/live-status.json";
const DEFAULT_CHECKPOINT_PATH = "/home/visar/.local/share/video-services/fix-playlists.sqlite";
const PROVIDERS = ["tango", "fc2"];
const RULE_VERSION = "max-av-v1";

function usage() {
    console.log(`Usage:
  node scripts/fix-historical-playlists.mjs [options]

Options:
  --provider tango|fc2|all  Provider to scan (default: all)
  --limit N                 Process at most N playlists
  --offset N                Skip the first N discovered playlists (default: 0)
  --concurrency N           Concurrent ffprobe processes (default: 1)
  --max-cpu N               Pause new probes above N% system CPU (default: 80)
  --checkpoint PATH         SQLite checkpoint path
                            (default: ${DEFAULT_CHECKPOINT_PATH})
  --no-resume               Ignore prior checkpoints for this run
  --apply                   Atomically rewrite changed playlists
  --dry-run                 Report changes without writing (default)
  --help                    Show this help

The script skips exact folders currently present in live-status.json. It is
idempotent: an already-correct playlist reports unchanged.`);
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
        limit: Number.POSITIVE_INFINITY,
        offset: 0,
        concurrency: 1,
        maxCpu: 80,
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

async function discoverPlaylists(provider) {
    const providers = provider === "all" ? PROVIDERS : [provider];
    const playlists = [];
    for (const currentProvider of providers) {
        const root = path.join(DOWNLOADS_ROOT, currentProvider, "downloader");
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
                playlists.push({ provider: currentProvider, playlistPath });
            } catch {
                // A folder without a playlist is not a migration target.
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

function parsePlaylist(content) {
    const lines = content.split(/\r?\n/);
    const segments = [];
    let pendingExtinfIndex = null;

    for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index].trim();
        if (trimmed.startsWith("#EXTINF:")) {
            pendingExtinfIndex = index;
            continue;
        }
        if (trimmed && !trimmed.startsWith("#") && pendingExtinfIndex !== null) {
            const durationText = lines[pendingExtinfIndex]
                .trim()
                .slice("#EXTINF:".length)
                .split(",")[0];
            const duration = Number.parseFloat(durationText);
            segments.push({
                duration: Number.isFinite(duration) ? duration : null,
                extinfIndex: pendingExtinfIndex,
                uri: trimmed,
            });
            pendingExtinfIndex = null;
        }
    }
    return { lines, segments };
}

async function probeDuration(filePath) {
    const { stdout } = await execFileAsync(
        "nice",
        [
            "-n", "10",
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration:stream=codec_type,duration",
            "-of", "json",
            filePath,
        ],
        { maxBuffer: 1024 * 1024 },
    );
    const data = JSON.parse(stdout);
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const videoDuration = Number.parseFloat(
        streams.find((stream) => stream.codec_type === "video")?.duration,
    );
    const audioDuration = Number.parseFloat(
        streams.find((stream) => stream.codec_type === "audio")?.duration,
    );
    const mediaDurations = [videoDuration, audioDuration]
        .filter((duration) => Number.isFinite(duration) && duration > 0);
    if (mediaDurations.length > 0) return Math.max(...mediaDurations);

    const formatDuration = Number.parseFloat(data.format?.duration);
    if (Number.isFinite(formatDuration) && formatDuration > 0) return formatDuration;
    throw new Error("ffprobe returned no positive media or format duration");
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

async function mapBounded(items, concurrency, operation) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            results[index] = await operation(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
}

async function atomicWrite(filePath, content) {
    const temporaryPath = `${filePath}.maxav-${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, content);
    await fs.rename(temporaryPath, filePath);
}

async function repairPlaylist(target, options, cpuGuard) {
    const directory = path.dirname(target.playlistPath);
    const activeDirectories = await readActiveDirectories();
    if (activeDirectories.has(path.resolve(directory))) {
        return { status: "live", segmentCount: 0 };
    }

    const original = await fs.readFile(target.playlistPath, "utf8");
    const parsed = parsePlaylist(original);
    if (parsed.segments.length === 0) {
        return { status: "empty", segmentCount: 0 };
    }

    const durations = await mapBounded(
        parsed.segments,
        options.concurrency,
        async (segment) => {
            await cpuGuard.waitForCapacity();
            const segmentPath = path.resolve(directory, segment.uri);
            if (path.dirname(segmentPath) !== path.resolve(directory)) {
                throw new Error(`Segment URI escapes playlist directory: ${segment.uri}`);
            }
            return probeDuration(segmentPath);
        },
    );

    let changedDurationCount = 0;
    let totalBefore = 0;
    let totalAfter = 0;
    let maximumDuration = 0;
    for (let index = 0; index < parsed.segments.length; index += 1) {
        const segment = parsed.segments[index];
        const roundedDuration = Number(durations[index].toFixed(3));
        maximumDuration = Math.max(maximumDuration, roundedDuration);
        totalBefore += segment.duration ?? 0;
        totalAfter += roundedDuration;
        if (segment.duration === null || Math.abs(segment.duration - roundedDuration) >= 0.0005) {
            changedDurationCount += 1;
        }
        parsed.lines[segment.extinfIndex] = `#EXTINF:${roundedDuration.toFixed(3)},`;
    }

    const desiredTargetDuration = Math.max(1, Math.ceil(maximumDuration));
    const targetIndex = parsed.lines.findIndex((line) => line.trim().startsWith("#EXT-X-TARGETDURATION:"));
    const existingTargetDuration = targetIndex >= 0
        ? Number.parseInt(parsed.lines[targetIndex].trim().slice("#EXT-X-TARGETDURATION:".length), 10)
        : null;
    if (targetIndex >= 0) {
        parsed.lines[targetIndex] = `#EXT-X-TARGETDURATION:${desiredTargetDuration}`;
    } else {
        const headerIndex = parsed.lines.findIndex((line) => line.trim() === "#EXTM3U");
        parsed.lines.splice(headerIndex >= 0 ? headerIndex + 1 : 0, 0, `#EXT-X-TARGETDURATION:${desiredTargetDuration}`);
    }

    const targetChanged = existingTargetDuration !== desiredTargetDuration;
    const changed = changedDurationCount > 0 || targetChanged;
    if (changed && options.apply) {
        const activeBeforeWrite = await readActiveDirectories();
        if (activeBeforeWrite.has(path.resolve(directory))) {
            return { status: "live", segmentCount: parsed.segments.length };
        }
        const trailingNewline = original.endsWith("\n") ? "\n" : "";
        await atomicWrite(target.playlistPath, `${parsed.lines.join("\n").replace(/\n+$/, "")}${trailingNewline}`);
    }

    return {
        status: changed ? (options.apply ? "written" : "would-change") : "unchanged",
        segmentCount: parsed.segments.length,
        changedDurationCount,
        targetChanged,
        totalBefore,
        totalAfter,
        delta: totalAfter - totalBefore,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    await fs.mkdir(path.dirname(options.checkpointPath), { recursive: true });
    const mode = options.apply ? "apply" : "dry-run";
    const checkpoints = new CheckpointStore(options.checkpointPath, mode);
    const discovered = await discoverPlaylists(options.provider);
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
        discovered: discovered.length,
        selected: selected.length,
        offset: options.offset,
        concurrency: options.concurrency,
        maxCpu: options.maxCpu,
        resume: options.resume,
        checkpointPath: options.checkpointPath,
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
