import * as fs from "fs/promises";
import * as path from "path";
import { fixTargetDuration } from "shared";
import logger from "../core/logger.js";
import { getProviderPaths, LIVE_STATUS_PATH } from "../core/config.js";
import type { LiveStatus } from "../core/types.js";

const ORPHAN_SWEEP_MS = 10 * 60 * 1_000;
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1_000;

const PROVIDERS = ["tango", "fc2", "sc"];

interface PlaylistSection {
    mapLine: string | null;
    entries: { metadata: string[]; segmentName: string }[];
}

interface ParsedPlaylist {
    headerLines: string[];
    sections: PlaylistSection[];
}

interface SegmentInventory {
    validSegments: Set<string>;
    corruptSegments: string[];
}

interface PlaylistRecovery {
    content: string;
    removedSegmentCount: number;
    strippedNulBytes: number;
    wasRebuilt: boolean;
    targetDurationFixed: boolean;
}

type OrphanRepairResult =
    | { kind: "deleted-empty" }
    | { kind: "unchanged" }
    | { kind: "repaired"; removedSegmentCount: number; strippedNulBytes: number; deletedCorruptSegmentCount: number };

function sanitizePlaylistContent(content: string): { content: string; strippedNulBytes: number } {
    const strippedNulBytes = content.length - content.replaceAll("\0", "").length;
    if (strippedNulBytes === 0) {
        return { content, strippedNulBytes: 0 };
    }

    return {
        content: content.replaceAll("\0", ""),
        strippedNulBytes,
    };
}

function parsePlaylist(content: string): ParsedPlaylist {
    const lines = content.split("\n");
    const headerLines: string[] = [];
    const sections: PlaylistSection[] = [];
    let currentSection: PlaylistSection = { mapLine: null, entries: [] };
    let metadataBuffer: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed === "#EXT-X-ENDLIST") continue;

        if (
            trimmed.startsWith("#EXTM3U") ||
            trimmed.startsWith("#EXT-X-VERSION") ||
            trimmed.startsWith("#EXT-X-TARGETDURATION") ||
            trimmed.startsWith("#EXT-X-MEDIA-SEQUENCE")
        ) {
            headerLines.push(trimmed);
            continue;
        }

        if (trimmed.startsWith("#EXT-X-MAP")) {
            if (currentSection.mapLine === null && currentSection.entries.length === 0) {
                currentSection.mapLine = trimmed;
            } else {
                sections.push(currentSection);
                currentSection = { mapLine: trimmed, entries: [] };
            }
            metadataBuffer = [];
            continue;
        }

        if (trimmed.startsWith("#")) {
            metadataBuffer.push(trimmed);
            continue;
        }

        currentSection.entries.push({
            metadata: [...metadataBuffer],
            segmentName: trimmed,
        });
        metadataBuffer = [];
    }

    sections.push(currentSection);
    return { headerLines, sections };
}

function getPlaylistSegmentNames(parsed: ParsedPlaylist): string[] {
    return parsed.sections.flatMap((section) => section.entries.map((entry) => entry.segmentName));
}

function rebuildPlaylist(parsed: ParsedPlaylist, validSegments: Set<string>): string {
    const lines: string[] = [];

    if (parsed.headerLines.length === 0) {
        parsed.headerLines = [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            "#EXT-X-TARGETDURATION:10",
            "#EXT-X-MEDIA-SEQUENCE:0",
        ];
    }
    lines.push(...parsed.headerLines);

    let isFirstSection = true;

    for (const section of parsed.sections) {
        const validEntries = section.entries.filter(e => validSegments.has(e.segmentName));
        if (validEntries.length === 0) continue;

        if (section.mapLine) {
            if (!isFirstSection) {
                lines.push("#EXT-X-DISCONTINUITY");
            }
            lines.push(section.mapLine);
        }

        for (const entry of validEntries) {
            lines.push(...entry.metadata);
            lines.push(entry.segmentName);
        }

        isFirstSection = false;
    }

    lines.push("#EXT-X-ENDLIST");

    let result = lines.join("\n") + "\n";
    const { content: fixed, wasFixed } = fixTargetDuration(result);
    if (wasFixed) result = fixed;

    return result;
}

function recoverPlaylist(playlistContent: string, inventory: SegmentInventory): PlaylistRecovery {
    const sanitized = sanitizePlaylistContent(playlistContent);
    const parsed = parsePlaylist(sanitized.content);
    const referencedSegments = getPlaylistSegmentNames(parsed);
    const removedSegmentCount = referencedSegments.filter((segmentName) => !inventory.validSegments.has(segmentName)).length;
    const isFinalized = sanitized.content.includes("#EXT-X-ENDLIST");

    if (!isFinalized || sanitized.strippedNulBytes > 0 || removedSegmentCount > 0) {
        return {
            content: rebuildPlaylist(parsed, inventory.validSegments),
            removedSegmentCount,
            strippedNulBytes: sanitized.strippedNulBytes,
            wasRebuilt: true,
            targetDurationFixed: false,
        };
    }

    const { content, wasFixed } = fixTargetDuration(sanitized.content);
    return {
        content,
        removedSegmentCount: 0,
        strippedNulBytes: 0,
        wasRebuilt: false,
        targetDurationFixed: wasFixed,
    };
}

async function getActiveSegmentPaths(): Promise<Set<string>> {
    try {
        const content = await fs.readFile(LIVE_STATUS_PATH, "utf-8");
        const liveData: LiveStatus = JSON.parse(content);
        if (liveData && Array.isArray(liveData.downloads)) {
            return new Set(
                liveData.downloads
                    .map(d => d.segmentsDirPath)
                    .filter((p): p is string => typeof p === "string")
            );
        }
    } catch {}
    return new Set();
}

async function buildSegmentInventory(streamPath: string, allFiles: string[]): Promise<SegmentInventory> {
    const validSegments = new Set<string>();
    const corruptSegments: string[] = [];

    for (const fileName of allFiles) {
        if (!fileName.endsWith(".ts")) continue;

        try {
            const stats = await fs.stat(path.join(streamPath, fileName));
            if (stats.size > 0) {
                validSegments.add(fileName);
            } else {
                corruptSegments.push(fileName);
            }
        } catch {
            corruptSegments.push(fileName);
        }
    }

    return { validSegments, corruptSegments };
}

async function deleteCorruptSegments(streamPath: string, segmentNames: string[]): Promise<number> {
    let deletedCount = 0;

    for (const segmentName of segmentNames) {
        try {
            await fs.rm(path.join(streamPath, segmentName), { force: true });
            deletedCount++;
        } catch (err: any) {
            logger.warn(`[System] Failed to delete corrupt segment ${segmentName} in ${path.basename(streamPath)}`, { error: err.message });
        }
    }

    return deletedCount;
}

async function repairOrphan(streamPath: string): Promise<OrphanRepairResult> {
    const allFiles = await fs.readdir(streamPath);
    const inventory = await buildSegmentInventory(streamPath, allFiles);

    if (inventory.validSegments.size === 0) {
        logger.info(`[System] Orphan folder ${path.basename(streamPath)} contains no valid segments. Deleting folder.`);
        await fs.rm(streamPath, { recursive: true, force: true });
        return { kind: "deleted-empty" };
    }

    const deletedCorruptSegmentCount = await deleteCorruptSegments(streamPath, inventory.corruptSegments);
    const playlistPath = path.join(streamPath, "playlist.m3u8");
    let playlistContent: string | null = null;
    try {
        playlistContent = await fs.readFile(playlistPath, "utf-8");
    } catch {}

    if (!playlistContent) {
        return deletedCorruptSegmentCount > 0
            ? { kind: "repaired", removedSegmentCount: 0, strippedNulBytes: 0, deletedCorruptSegmentCount }
            : { kind: "unchanged" };
    }

    const recovery = recoverPlaylist(playlistContent, inventory);
    if (recovery.wasRebuilt || recovery.targetDurationFixed) {
        await fs.writeFile(playlistPath, recovery.content);
    }

    if (!recovery.wasRebuilt && !recovery.targetDurationFixed && deletedCorruptSegmentCount === 0) {
        return { kind: "unchanged" };
    }

    return {
        kind: "repaired",
        removedSegmentCount: recovery.removedSegmentCount,
        strippedNulBytes: recovery.strippedNulBytes,
        deletedCorruptSegmentCount,
    };
}

async function processOrphans(): Promise<void> {
    logger.info("[System] Starting orphan stream finalizer check...");
    const activePaths = await getActiveSegmentPaths();

    let totalProcessed = 0;
    let totalFixed = 0;
    let totalDeleted = 0;

    for (const provider of PROVIDERS) {
        const streamsLocation = getProviderPaths(provider).downloader;
        const stats = await cleanServiceDirectory(streamsLocation, activePaths);
        totalProcessed += stats.processed;
        totalFixed += stats.fixed;
        totalDeleted += stats.deleted;
    }

    logger.info(
        `[System] Orphan stream finalizer check complete. Scanned ${totalProcessed} orphans. Deleted ${totalDeleted} empty folders. Fixed/Synced ${totalFixed} playlists.`
    );
}

async function cleanServiceDirectory(streamsLocation: string, activePaths: Set<string>): Promise<{ processed: number; fixed: number; deleted: number }> {
    const stats = { processed: 0, fixed: 0, deleted: 0 };

    try {
        try {
            await fs.access(streamsLocation);
        } catch {
            return stats;
        }

        const streamDirs = await fs.readdir(streamsLocation, { withFileTypes: true });

        for (const dirent of streamDirs) {
            if (!dirent.isDirectory()) continue;

            const streamPath = path.join(streamsLocation, dirent.name);
            if (activePaths.has(streamPath)) continue;

            try {
                const fileStats = await fs.stat(streamPath);
                const ageMs = Date.now() - fileStats.mtimeMs;
                if (ageMs < ORPHAN_MIN_AGE_MS) continue;
            } catch {
                continue;
            }

            stats.processed++;

            try {
                const result = await repairOrphan(streamPath);
                if (result.kind === "deleted-empty") {
                    stats.deleted++;
                } else if (result.kind === "repaired") {
                    stats.fixed++;
                    if (result.removedSegmentCount > 0 || result.strippedNulBytes > 0 || result.deletedCorruptSegmentCount > 0) {
                        logger.info(
                            `[System] Rebuilt orphan playlist ${dirent.name}: removed ${result.removedSegmentCount} invalid referenced segment(s), stripped ${result.strippedNulBytes} NUL byte(s), deleted ${result.deletedCorruptSegmentCount} corrupt segment file(s)`
                        );
                    }
                }
            } catch (err: any) {
                logger.error(`[System] Error processing orphan ${dirent.name}`, { error: err.message });
            }
        }
    } catch (error: any) {
        logger.error(`[System] Error processing directory ${streamsLocation}`, { errorMessage: error.message });
    }

    return stats;
}

export function startOrphanStreamFinalizer(): void {
    let running = false;

    const runOnce = async () => {
        if (running) {
            logger.warn("[System] Skipping orphan stream finalizer check because the previous run is still active.");
            return;
        }

        running = true;
        try {
            await processOrphans();
        } finally {
            running = false;
        }
    };

    void runOnce();
    setInterval(() => void runOnce(), ORPHAN_SWEEP_MS);
}
