import * as fs from "fs/promises";
import * as path from "path";
import { config } from "../../common/config.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { fixTargetDuration } from "shared";
import { DownloadsManager } from "../state/downloadsManager.js";

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
                // First MAP in this section — assign it
                currentSection.mapLine = trimmed;
            } else {
                // New section starts (quality change)
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

        // Segment line
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

    // Reconstruct header if missing
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
        // Filter to segments that exist on disk
        const validEntries = section.entries.filter(e => filesOnDisk.has(e.segmentName));
        if (validEntries.length === 0) continue;

        // First section's MAP goes right after the header.
        // Subsequent sections get DISCONTINUITY + MAP.
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

export class OrphanStreamFinalizer {
    private downloadsManager: DownloadsManager;
    private readonly checkInterval: number = 24 * 60 * 60 * 1000;

    constructor(downloadsManager: DownloadsManager) {
        this.downloadsManager = downloadsManager;
    }

    public start(): void {
        void this.processOrphans();
        setTimeout(() => void this.processOrphans(), 5 * 60 * 1000);
        setTimeout(() => {
            const runLoop = async () => {
                await this.processOrphans();
                setTimeout(runLoop, this.checkInterval);
            };
            void runLoop();
        }, this.checkInterval);
    }

    private async processOrphans(): Promise<void> {
        logger.info("[System] Starting orphan stream finalizer check...");
        const activePaths = this.downloadsManager.getActiveSegmentPaths();

        const services = ["tango", "fc2", "sc"];

        let totalProcessed = 0;
        let totalFixed = 0;
        let totalDeleted = 0;

        for (const service of services) {
            const streamsLocation = path.join(config.storagePath, service, "downloader");
            const stats = await this.cleanServiceDirectory(streamsLocation, activePaths);

            totalProcessed += stats.processed;
            totalFixed += stats.fixed;
            totalDeleted += stats.deleted;
        }

        logger.info(
            `[System] Orphan stream finalizer check complete. Scanned ${totalProcessed} orphans. Deleted ${totalDeleted} empty folders. Fixed/Synced ${totalFixed} playlists.`
        );
    }

    private async cleanServiceDirectory(streamsLocation: string, activePaths: Set<string>): Promise<{ processed: number, fixed: number, deleted: number }> {
        const stats = { processed: 0, fixed: 0, deleted: 0 };

        try {
            try {
                await fs.access(streamsLocation);
            } catch {
                return stats;
            }

            const streamDirs = await fs.readdir(streamsLocation, { withFileTypes: true });

            for (const dirent of streamDirs) {
                if (dirent.isDirectory()) {
                    const streamPath = path.join(streamsLocation, dirent.name);

                    if (activePaths.has(streamPath)) {
                        continue;
                    }

                    try {
                        const fileStats = await fs.stat(streamPath);
                        const ageMs = Date.now() - fileStats.mtimeMs;
                        if (ageMs < 60 * 60 * 1000) {
                            continue;
                        }
                    } catch (e) {
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
                        if (await FileSystemManager.pathExists(playlistPath)) {
                            const content = await FileSystemManager.readFile(playlistPath);
                            if (content) {
                                const isFinalized = content.includes("#EXT-X-ENDLIST");

                                if (isFinalized) {
                                    const { content: fixedContent, wasFixed } = fixTargetDuration(content);
                                    if (wasFixed) {
                                        await FileSystemManager.writeFile(playlistPath, fixedContent);
                                        stats.fixed++;
                                    }
                                } else {
                                    const filesOnDisk = new Set(allFiles);
                                    const parsed = parsePlaylist(content);
                                    const rebuilt = rebuildPlaylist(parsed, filesOnDisk);
                                    await FileSystemManager.writeFile(playlistPath, rebuilt);
                                    stats.fixed++;

                                    const removedCount = parsed.sections
                                        .flatMap(s => s.entries)
                                        .filter(e => !filesOnDisk.has(e.segmentName)).length;
                                    if (removedCount > 0) {
                                        logger.info(`[System] Rebuilt orphan playlist ${dirent.name}: removed ${removedCount} missing segment(s)`);
                                    }
                                }
                            }
                        }
                    } catch (err: any) {
                        logger.error(`[System] Error processing orphan ${dirent.name}`, { error: err.message });
                    }
                }
            }
        } catch (error: any) {
            logger.error(`[System] Error processing directory ${streamsLocation}`, { errorMessage: error.message });
        }

        return stats;
    }
}
