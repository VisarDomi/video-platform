import { promises as fs } from "node:fs";
import path from "node:path";

export interface ManagedRecordingRoot {
    readonly provider: string;
    readonly scope: string;
    readonly rootPath: string;
}

export interface HistoricalFinalizationTarget {
    readonly provider: string;
    readonly scope: string;
    readonly recordingPath: string;
}

export async function resolveManagedRecordingTarget(
    requestedPath: string,
    roots: readonly ManagedRecordingRoot[],
): Promise<HistoricalFinalizationTarget> {
    const recordingPath = path.resolve(requestedPath);
    const basename = path.basename(recordingPath);
    if (basename.startsWith(".")) {
        throw new Error("--recording must name a visible finalized recording");
    }

    const root = roots.find((candidate) => path.resolve(candidate.rootPath) === path.dirname(recordingPath));
    if (!root) {
        throw new Error("--recording must be an immediate child of a managed downloader or edited root");
    }

    const stats = await fs.lstat(recordingPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("--recording must be a directly owned recording directory, not a symlink");
    }

    const playlistStats = await fs.lstat(path.join(recordingPath, "playlist.m3u8"));
    if (!playlistStats.isFile() || playlistStats.isSymbolicLink()) {
        throw new Error("--recording must contain a directly owned playlist.m3u8 file");
    }

    return {
        provider: root.provider,
        scope: root.scope,
        recordingPath,
    };
}
