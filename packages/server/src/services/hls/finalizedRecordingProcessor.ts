import { promises as fs } from "node:fs";
import path from "node:path";
import { moveToDesktopTrash } from "shared";

import { repairFailedMediaIntegrity } from "./failedIntegrityRepair.js";
import {
    finalizeMediaIntegrity,
    type MediaIntegrityFinalizationResult,
    type MediaIntegrityFinalizerOptions,
    type MediaIntegrityReport,
} from "./mediaIntegrityFinalizer.js";
import { repairPlaylistDurations } from "./playlistAuthority.js";

export interface FinalizedRecordingProcessorDependencies {
    readonly cleanup?: (streamPath: string) => Promise<void>;
    readonly repairPlaylist?: (streamPath: string) => Promise<unknown>;
    readonly validate?: (
        streamPath: string,
        options: MediaIntegrityFinalizerOptions,
    ) => Promise<MediaIntegrityFinalizationResult>;
    readonly repairFailed?: (streamPath: string) => Promise<{ finalReport: MediaIntegrityReport }>;
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
    const cleanup = dependencies.cleanup ?? moveUnreferencedTransportSegmentsToTrash;
    const repairPlaylist = dependencies.repairPlaylist
        ?? ((target: string) => repairPlaylistDurations(target, { apply: true }));
    const validate = dependencies.validate ?? finalizeMediaIntegrity;
    const repairFailed = dependencies.repairFailed ?? repairFailedMediaIntegrity;
    await cleanup(streamPath);
    await repairPlaylist(streamPath);
    const initial = await validate(streamPath, options);
    if (
        initial.kind !== "not-finalized"
        && initial.report.version === 2
        && initial.report.status === "failed"
        && initial.report.invalidSegments.length > 0
    ) {
        const repaired = await repairFailed(streamPath);
        return { kind: "processed", report: repaired.finalReport };
    }
    return initial;
}
