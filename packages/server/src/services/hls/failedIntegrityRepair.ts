import { promises as fs } from "node:fs";
import path from "node:path";
import { moveToDesktopTrash } from "shared";
import { FILE_NAMES, HLS, MISC } from "../../core/constants.js";
import {
    finalizeMediaIntegrity,
    type MediaIntegrityFinalizationResult,
    type MediaIntegrityReport,
} from "./mediaIntegrityFinalizer.js";
import {
    dropFmp4FragmentsFromPlaylist,
    dropSegmentsFromPlaylist,
    repairPlaylistDurations,
} from "./playlistAuthority.js";

export interface FailedIntegrityRepairDependencies {
    readonly dropFile?: (filePath: string) => Promise<void>;
    readonly repairPlaylist?: (streamPath: string) => Promise<unknown>;
    readonly revalidate?: (streamPath: string) => Promise<MediaIntegrityFinalizationResult>;
}

export interface FailedIntegrityRepairResult {
    readonly streamPath: string;
    readonly reportedInvalidSegmentNames: readonly string[];
    readonly removedPlaylistSegmentNames: readonly string[];
    readonly alreadyAbsentPlaylistSegmentNames: readonly string[];
    readonly droppedSegmentNames: readonly string[];
    readonly dropDestination: "desktop-trash";
    readonly alreadyAbsentFileNames: readonly string[];
    readonly insertedDiscontinuityCount: number;
    readonly finalReport: MediaIntegrityReport;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
        await fs.writeFile(temporaryPath, content, MISC.ENCODING_UTF8);
        await fs.rename(temporaryPath, filePath);
    } finally {
        await fs.rm(temporaryPath, { force: true });
    }
}

function safeInvalidSegmentNames(report: MediaIntegrityReport): string[] {
    const names = [...new Set(report.invalidSegments.map((segment) => segment.name))];
    if (names.length === 0) throw new Error("Failed integrity report has no attributable media segments");
    for (const name of names) {
        if (path.basename(name) !== name || (!name.endsWith(".ts") && !name.endsWith(".m4s"))) {
            throw new Error(`Unsafe invalid segment name: ${name}`);
        }
    }
    return names;
}

export async function repairFailedMediaIntegrity(
    streamPath: string,
    report: MediaIntegrityReport,
    dependencies: FailedIntegrityRepairDependencies = {},
): Promise<FailedIntegrityRepairResult> {
    const resolvedStreamPath = path.resolve(streamPath);
    const playlistPath = path.join(resolvedStreamPath, FILE_NAMES.HLS_PLAYLIST);
    if (report.version !== 2 || report.status !== "failed") {
        throw new Error("Repair requires a failed version-2 integrity result");
    }
    const invalidSegmentNames = safeInvalidSegmentNames(report);
    const originalPlaylist = await fs.readFile(playlistPath, MISC.ENCODING_UTF8);
    if (!originalPlaylist.split(/\r?\n/).some((line) => line.trim() === HLS.ENDLIST)) {
        throw new Error("Refusing to repair a playlist without ENDLIST");
    }

    const hasMap = originalPlaylist.split(/\r?\n/).some((line) => line.trim().startsWith(HLS.MAP_PREFIX));
    const dropped = hasMap
        ? dropFmp4FragmentsFromPlaylist(originalPlaylist, new Set(invalidSegmentNames))
        : dropSegmentsFromPlaylist(originalPlaylist, new Set(invalidSegmentNames));
    if (dropped.removedSegmentNames.length > 0) {
        await writeFileAtomic(playlistPath, dropped.content);
    }

    const repairPlaylist = dependencies.repairPlaylist
        ?? ((target: string) => repairPlaylistDurations(target, { apply: true }));
    await repairPlaylist(resolvedStreamPath);

    const dropFile = dependencies.dropFile ?? moveToDesktopTrash;
    const droppedSegmentNames: string[] = [];
    const alreadyAbsentFileNames: string[] = [];
    for (const name of invalidSegmentNames) {
        const filePath = path.join(resolvedStreamPath, name);
        try {
            const stats = await fs.lstat(filePath);
            if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Invalid segment is not a directly owned file: ${name}`);
        } catch (error: any) {
            if (error?.code === MISC.ERROR_CODE.ENOENT) {
                alreadyAbsentFileNames.push(name);
                continue;
            }
            throw error;
        }
        await dropFile(filePath);
        droppedSegmentNames.push(name);
    }

    const revalidate = dependencies.revalidate
        ?? ((target: string) => finalizeMediaIntegrity(target, { retryFailed: true, revalidate: true }));
    const finalization = await revalidate(resolvedStreamPath);
    if (finalization.kind === "not-finalized") {
        throw new Error("Repaired recording did not produce a version-2 integrity report");
    }
    const finalReport = finalization.report;

    return {
        streamPath: resolvedStreamPath,
        reportedInvalidSegmentNames: invalidSegmentNames,
        removedPlaylistSegmentNames: dropped.removedSegmentNames,
        alreadyAbsentPlaylistSegmentNames: dropped.missingSegmentNames,
        droppedSegmentNames,
        dropDestination: "desktop-trash",
        alreadyAbsentFileNames,
        insertedDiscontinuityCount: dropped.insertedDiscontinuityCount,
        finalReport,
    };
}
