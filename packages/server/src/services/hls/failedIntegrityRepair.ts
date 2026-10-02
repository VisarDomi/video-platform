import { promises as fs } from "node:fs";
import path from "node:path";
import { moveToDesktopTrash, parseNativeMediaPlaylist } from "shared";
import { FILE_NAMES, HLS, MISC } from "../../core/constants.js";
import {
    finalizeMediaIntegrity,
    validateNativeMediaPlaylist,
    type MediaIntegrityFinalizationResult,
    type MediaIntegrityReport,
} from "./mediaIntegrityFinalizer.js";
import { FinalizationCheckpointStore, playlistFingerprint } from "./finalizationCheckpointStore.js";
import {
    dropFmp4FragmentsFromPlaylist,
    dropSegmentsFromPlaylist,
    repairPlaylistDurations,
} from "./playlistAuthority.js";

export interface FailedIntegrityRepairDependencies {
    readonly dropFile?: (filePath: string) => Promise<void>;
    readonly repairPlaylist?: (streamPath: string) => Promise<unknown>;
    readonly revalidate?: (streamPath: string) => Promise<MediaIntegrityFinalizationResult>;
    readonly validateCandidate?: (streamPath: string, content: string) => Promise<boolean>;
    readonly checkpointStore?: FinalizationCheckpointStore;
}

export interface MediaRepairPlan {
    readonly report: MediaIntegrityReport;
    readonly originalPlaylist: string;
    readonly candidatePlaylist: string;
    readonly invalidSegmentNames: string[];
    phase: "planned" | "verified" | "published";
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
        const file = await fs.open(temporaryPath, "r");
        try { await file.sync(); } finally { await file.close(); }
        await fs.rename(temporaryPath, filePath);
        const directory = await fs.open(path.dirname(filePath), "r");
        try { await directory.sync(); } finally { await directory.close(); }
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
    const savedPlan = dependencies.checkpointStore?.readRepair<MediaRepairPlan>(resolvedStreamPath);
    const invalidSegmentNames = savedPlan?.invalidSegmentNames ?? safeInvalidSegmentNames(report);
    const originalPlaylist = await fs.readFile(playlistPath, MISC.ENCODING_UTF8);
    if (!originalPlaylist.split(/\r?\n/).some((line) => line.trim() === HLS.ENDLIST)) {
        throw new Error("Refusing to repair a playlist without ENDLIST");
    }

    const hasMap = originalPlaylist.split(/\r?\n/).some((line) => line.trim().startsWith(HLS.MAP_PREFIX));
    const dropped = hasMap
        ? dropFmp4FragmentsFromPlaylist(originalPlaylist, new Set(invalidSegmentNames))
        : dropSegmentsFromPlaylist(originalPlaylist, new Set(invalidSegmentNames));
    const plan: MediaRepairPlan = savedPlan ?? { report, originalPlaylist,
        candidatePlaylist: dropped.content, invalidSegmentNames, phase: "planned" };
    const save = () => dependencies.checkpointStore?.writeRepair(resolvedStreamPath, plan);
    const mediaIdentity = (content: string) => JSON.stringify(parseNativeMediaPlaylist(content).segments
        .map(segment => [segment.name, segment.mapUri, segment.metadata.includes(HLS.DISCONTINUITY)]));
    if (savedPlan && originalPlaylist !== plan.originalPlaylist
        && mediaIdentity(originalPlaylist) !== mediaIdentity(plan.candidatePlaylist)) {
        throw new Error("Recording changed outside the durable repair plan; refusing to remove files");
    }
    if (plan.phase === "published" && mediaIdentity(originalPlaylist) !== mediaIdentity(plan.candidatePlaylist)) {
        throw new Error("Published repair was replaced; refusing to remove referenced source files");
    }
    save();
    if (plan.phase === "planned") {
        const validateCandidate = dependencies.validateCandidate ?? (async (target: string, content: string) =>
            (await validateNativeMediaPlaylist(target, content)).valid);
        if (!await validateCandidate(resolvedStreamPath, plan.candidatePlaylist)) {
            throw new Error("Retained candidate still fails native validation; originals and repair plan preserved");
        }
        plan.phase = "verified";
        save();
    }
    // Verification is durable BEFORE publication; publication is durable
    // BEFORE trashing. A crash at either boundary can resume from SQLite.
    if (originalPlaylist !== plan.candidatePlaylist && plan.phase !== "published") {
        await writeFileAtomic(playlistPath, plan.candidatePlaylist);
    }
    plan.phase = "published";
    save();

    const repairPlaylist = dependencies.repairPlaylist
        ?? ((target: string) => repairPlaylistDurations(target, { apply: true }));
    await repairPlaylist(resolvedStreamPath);

    // Verify any authoritative-duration rewrite before moving source files.
    const revalidate = dependencies.revalidate
        ?? ((target: string) => finalizeMediaIntegrity(target, { retryFailed: true, revalidate: true,
            checkpointStore: dependencies.checkpointStore }));
    const finalization = await revalidate(resolvedStreamPath);
    if (finalization.kind === "not-finalized") throw new Error("Repaired recording is not finalized");
    const finalReport = finalization.report;
    if (finalReport.status !== "ready" && finalReport.status !== "empty") {
        throw new Error("Published repair did not validate; excluded files retained for recovery");
    }

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

    finalReport.detectedInvalidSegments = report.detectedInvalidSegments ?? report.invalidSegments;
    dependencies.checkpointStore?.write(resolvedStreamPath,
        playlistFingerprint(await fs.readFile(playlistPath, "utf8")), finalReport);
    dependencies.checkpointStore?.clearRepair(resolvedStreamPath);

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
