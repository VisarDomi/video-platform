import { promises as fs } from "node:fs";
import path from "node:path";

import logger from "../../core/logger.js";
import {
    finalizeMediaIntegrity,
    type MediaIntegrityFinalizationResult,
    type MediaIntegrityFinalizerOptions,
    type MediaIntegrityReport,
    type MediaIntegrityWarning,
} from "./mediaIntegrityFinalizer.js";
import { type FinalizationCheckpointStore, playlistFingerprint } from "./finalizationCheckpointStore.js";
import {
    annotateCompoundSequenceRestarts,
    repairPlaylistDurations,
} from "./playlistAuthority.js";

// Finalization is NON-DESTRUCTIVE: it may rewrite playlist.m3u8 (durations,
// discontinuity tags) but never removes a playlist entry and never moves or
// deletes a media file. Problems are reported as warnings on the report.
export interface FinalizedRecordingProcessorDependencies {
    // Playlist-only repair; returns findings to record as warnings.
    readonly repairPlaylist?: (streamPath: string) => Promise<readonly MediaIntegrityWarning[] | void>;
    readonly listUnreferenced?: (streamPath: string) => Promise<readonly string[]>;
    readonly validate?: (
        streamPath: string,
        options: MediaIntegrityFinalizerOptions,
    ) => Promise<MediaIntegrityFinalizationResult>;
}

// Journal shape written by the retired destructive repair (validator <= 3).
interface RetiredRepairJournal {
    readonly originalPlaylist?: string;
    readonly candidatePlaylist?: string;
    readonly invalidSegmentNames?: readonly string[];
    readonly phase?: string;
}

function isOwnedMediaFile(name: string): boolean {
    return name.endsWith(".ts")
        || name.endsWith(".m4s")
        || /^init(?:_\d+(?:_\d+)?)?\.mp4$/.test(name);
}

// Media files in the recording folder that the playlist does not reference
// (segments or init maps). They are reported and left exactly where they are.
export async function findUnreferencedMediaFiles(streamPath: string): Promise<string[]> {
    const playlist = await fs.readFile(path.join(streamPath, "playlist.m3u8"), "utf8");
    const referenced = new Set<string>();
    for (const rawLine of playlist.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "") continue;
        const map = line.match(/^#EXT-X-MAP:.*\bURI="([^"]+)"/);
        if (map) referenced.add(map[1]);
        else if (!line.startsWith("#")) referenced.add(line);
    }
    const files = await fs.readdir(streamPath, { withFileTypes: true });
    return files
        .filter((file) => file.isFile() && isOwnedMediaFile(file.name) && !referenced.has(file.name))
        .map((file) => file.name)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

async function defaultRepairPlaylist(streamPath: string): Promise<MediaIntegrityWarning[]> {
    const restarts = await annotateCompoundSequenceRestarts(streamPath);
    await repairPlaylistDurations(streamPath, { apply: true });
    return restarts.restartSegmentNames.length === 0 ? [] : [{
        kind: "sequence-restart",
        message: `provider media sequence restarted ${restarts.restartSegmentNames.length} time(s); every segment kept`
            + (restarts.insertedDiscontinuityCount > 0
                ? `, ${restarts.insertedDiscontinuityCount} missing discontinuity tag(s) added`
                : ""),
        names: [...restarts.restartSegmentNames],
    }];
}

// A journal left by the retired destructive repair is resolved without moving
// any file: whichever playlist is on disk (original, or the already-published
// candidate) is kept as is, and the journal is cleared.
async function clearRetiredRepairJournal(
    streamPath: string,
    checkpointStore: FinalizationCheckpointStore | undefined,
): Promise<MediaIntegrityWarning | null> {
    const journal = checkpointStore?.readRepair<RetiredRepairJournal>(streamPath);
    if (!journal || !checkpointStore) return null;
    const playlist = await fs.readFile(path.join(streamPath, "playlist.m3u8"), "utf8");
    const playlistState = playlist === journal.candidatePlaylist
        ? "candidate already published; kept as is"
        : playlist === journal.originalPlaylist
            ? "original playlist retained"
            : "playlist differs from both journal versions; kept as is";
    checkpointStore.clearRepair(streamPath);
    const names = [...(journal.invalidSegmentNames ?? [])];
    logger.warn("[Finalization] cleared a retired destructive repair journal; no files moved", {
        streamPath,
        phase: journal.phase ?? null,
        playlistState,
        segmentNames: names,
    });
    return {
        kind: "retired-repair-journal",
        message: `a destructive repair journal (phase ${journal.phase ?? "unknown"}) was cleared without moving files: ${playlistState}`,
        names,
    };
}

export async function processFinalizedRecording(
    streamPath: string,
    options: MediaIntegrityFinalizerOptions = {},
    dependencies: FinalizedRecordingProcessorDependencies = {},
): Promise<MediaIntegrityFinalizationResult> {
    const retiredJournal = await clearRetiredRepairJournal(streamPath, options.checkpointStore);
    if (options.checkpointStore && options.revalidate !== true && !retiredJournal) {
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

    const repairPlaylist = dependencies.repairPlaylist ?? defaultRepairPlaylist;
    const listUnreferenced = dependencies.listUnreferenced ?? findUnreferencedMediaFiles;
    const validate = dependencies.validate ?? finalizeMediaIntegrity;

    const findings: MediaIntegrityWarning[] = retiredJournal ? [retiredJournal] : [];
    findings.push(...(await repairPlaylist(streamPath) ?? []));
    const unreferenced = await listUnreferenced(streamPath);
    if (unreferenced.length > 0) {
        findings.push({
            kind: "unreferenced-media",
            message: `${unreferenced.length} media file(s) on disk are not referenced by the playlist; left in place`,
            names: [...unreferenced],
        });
    }
    return validate(streamPath, {
        ...options,
        // A cleared journal may sit next to a ready checkpoint that predates
        // it; validate again so the report records the journal.
        revalidate: options.revalidate === true || retiredJournal !== null,
        findings: [...(options.findings ?? []), ...findings],
    });
}
