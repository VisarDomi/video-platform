import { promises as fs } from "node:fs";
import path from "node:path";
import { moveToDesktopTrash } from "shared";

import { repairFailedMediaIntegrity, type MediaRepairPlan } from "./failedIntegrityRepair.js";
import {
    finalizeMediaIntegrity,
    type MediaIntegrityFinalizationResult,
    type MediaIntegrityFinalizerOptions,
    type MediaIntegrityReport,
    validateNativeMediaPlaylist,
} from "./mediaIntegrityFinalizer.js";
import { playlistFingerprint } from "./finalizationCheckpointStore.js";
import {
    repairPlaylistDurations,
    repairRegressedCompoundSegments,
} from "./playlistAuthority.js";

export interface FinalizedRecordingProcessorDependencies {
    readonly cleanup?: (streamPath: string) => Promise<void>;
    readonly repairPlaylist?: (streamPath: string) => Promise<unknown>;
    readonly validate?: (
        streamPath: string,
        options: MediaIntegrityFinalizerOptions,
    ) => Promise<MediaIntegrityFinalizationResult>;
    readonly repairFailed?: (
        streamPath: string,
        report: MediaIntegrityReport,
    ) => Promise<{ finalReport: MediaIntegrityReport }>;
}

export async function moveUnreferencedTransportSegmentsToTrash(
    streamPath: string,
    moveFile: (filePath: string) => Promise<void> = moveToDesktopTrash,
): Promise<void> {
    const playlist = await fs.readFile(path.join(streamPath, "playlist.m3u8"), "utf8");
    const playlistLines = playlist.split(/\r?\n/);
    const referenced = new Set(playlistLines
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#")));
    for (const rawLine of playlistLines) {
        const map = rawLine.trim().match(/^#EXT-X-MAP:.*\bURI="([^"]+)"/);
        if (map) referenced.add(map[1]);
    }
    const files = await fs.readdir(streamPath, { withFileTypes: true });
    for (const file of files) {
        const isOwnedMedia = file.name.endsWith(".ts")
            || file.name === "init.mp4"
            || /^init_\d+(?:_\d+)?\.mp4$/.test(file.name);
        if (!file.isFile() || !isOwnedMedia || referenced.has(file.name)) continue;
        await moveFile(path.join(streamPath, file.name));
    }
}

export async function processFinalizedRecording(
    streamPath: string,
    options: MediaIntegrityFinalizerOptions = {},
    dependencies: FinalizedRecordingProcessorDependencies = {},
): Promise<MediaIntegrityFinalizationResult> {
    // Do not let ordinary cleanup trash files from a half-committed repair,
    // or let an already-ready checkpoint bypass its unfinished journal.
    const pendingRepair = options.checkpointStore?.readRepair<MediaRepairPlan>(streamPath);
    if (pendingRepair) {
        const repaired = dependencies.repairFailed ? await dependencies.repairFailed(streamPath, pendingRepair.report)
            : await repairFailedMediaIntegrity(streamPath, pendingRepair.report, {
                checkpointStore: options.checkpointStore,
                validateCandidate: async (target, content) =>
                    (await validateNativeMediaPlaylist(target, content, options.validateMedia, { inspectFragment: options.inspectFragment })).valid,
                revalidate: target => finalizeMediaIntegrity(target, { ...options, retryFailed: true, revalidate: true }),
            });
        return { kind: "processed", report: repaired.finalReport };
    }
    if (options.checkpointStore && options.revalidate !== true) {
        const playlistPath = path.join(streamPath, "playlist.m3u8");
        const playlist = await fs.readFile(playlistPath, "utf8");
        const existingReport = options.checkpointStore.read<MediaIntegrityReport>(
            streamPath,
            playlistFingerprint(playlist),
        );
        if (existingReport?.version === 2 && existingReport.status === "ready") {
            return { kind: "already-processed", report: existingReport };
        }
    }

    const cleanup = dependencies.cleanup ?? moveUnreferencedTransportSegmentsToTrash;
    const repairPlaylist = dependencies.repairPlaylist ?? (async (target: string) => {
        await repairRegressedCompoundSegments(target);
        return repairPlaylistDurations(target, { apply: true });
    });
    const validate = dependencies.validate ?? finalizeMediaIntegrity;
    const repairFailed = dependencies.repairFailed
        ?? ((target: string, report: MediaIntegrityReport) => repairFailedMediaIntegrity(target, report, {
            checkpointStore: options.checkpointStore,
            validateCandidate: async (candidateTarget, content) =>
                (await validateNativeMediaPlaylist(candidateTarget, content, options.validateMedia, { inspectFragment: options.inspectFragment })).valid,
            revalidate: (revalidationTarget) => finalizeMediaIntegrity(revalidationTarget, {
                ...options,
                retryFailed: true,
                revalidate: true,
            }),
        }));
    await repairPlaylist(streamPath);
    await cleanup(streamPath);
    const initial = await validate(streamPath, options);
    if (
        initial.kind !== "not-finalized"
        && initial.report.version === 2
        && initial.report.status === "failed"
        && initial.report.invalidSegments.length > 0
    ) {
        const repaired = await repairFailed(streamPath, initial.report);
        return { kind: "processed", report: repaired.finalReport };
    }
    return initial;
}
