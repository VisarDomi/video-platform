import * as fs from "fs/promises";
import * as path from "path";
import { fixTargetDuration } from "shared";
import logger from "../core/logger.js";
import { getProviderPaths, LIVE_STATUS_PATH } from "../core/config.js";
import type { LiveStatus } from "../core/types.js";

const ORPHAN_SECOND_CHECK_MS = 5 * 60 * 1_000;
const ORPHAN_CYCLE_MS = 24 * 60 * 60 * 1_000;
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

function rebuildPlaylist(parsed: ParsedPlaylist, filesOnDisk: Set<string>): string {
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
        const validEntries = section.entries.filter(e => filesOnDisk.has(e.segmentName));
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
                const allFiles = await fs.readdir(streamPath);
                const tsFiles = allFiles.filter((f) => f.endsWith(".ts"));

                if (tsFiles.length === 0) {
                    logger.info(`[System] Orphan folder ${dirent.name} contains no segments. Deleting folder.`);
                    await fs.rm(streamPath, { recursive: true, force: true });
                    stats.deleted++;
                    continue;
                }

                const playlistPath = path.join(streamPath, "playlist.m3u8");
                let playlistContent: string | null = null;
                try {
                    playlistContent = await fs.readFile(playlistPath, "utf-8");
                } catch {}

                if (playlistContent) {
                    const isFinalized = playlistContent.includes("#EXT-X-ENDLIST");

                    if (isFinalized) {
                        const { content: fixedContent, wasFixed } = fixTargetDuration(playlistContent);
                        if (wasFixed) {
                            await fs.writeFile(playlistPath, fixedContent);
                            stats.fixed++;
                        }
                    } else {
                        const filesOnDisk = new Set(allFiles);
                        const parsed = parsePlaylist(playlistContent);
                        const rebuilt = rebuildPlaylist(parsed, filesOnDisk);
                        await fs.writeFile(playlistPath, rebuilt);
                        stats.fixed++;

                        const removedCount = parsed.sections
                            .flatMap(s => s.entries)
                            .filter(e => !filesOnDisk.has(e.segmentName)).length;
                        if (removedCount > 0) {
                            logger.info(`[System] Rebuilt orphan playlist ${dirent.name}: removed ${removedCount} missing segment(s)`);
                        }
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
    void processOrphans();
    setTimeout(() => void processOrphans(), ORPHAN_SECOND_CHECK_MS);
    setTimeout(() => {
        const runLoop = async () => {
            await processOrphans();
            setTimeout(runLoop, ORPHAN_CYCLE_MS);
        };
        void runLoop();
    }, ORPHAN_CYCLE_MS);
}
