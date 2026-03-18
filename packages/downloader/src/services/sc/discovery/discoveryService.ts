import * as timersPromises from "timers/promises";
import * as path from "path";
import logger from "../../../common/logger.js";
import * as config from "../../../common/config.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { TargetManager } from "../../common/targetManager.js";
import { StreaMonitorAdapter, SegmentEntry } from "../api/streaMonitorAdapter.js";
import { PlaylistManager } from "../../download/playlistManager.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";

const FINALIZE_GRACE_MS = 30_000;

interface ActiveSession {
    sessionDir: string;
    username: string;
    playlistManager: PlaylistManager;
    jsonlOffset: number;
    masterUrl: string;
    headerWritten: boolean;
    segmentCount: number;
    trackedSince: number;
}

export class ScDiscoveryService {
    private targetManager: TargetManager;
    private adapter: StreaMonitorAdapter;
    private downloadsManager: DownloadsManager;
    private activeSessions: Map<string, ActiveSession> = new Map();
    private finalizedDirs: Set<string> = new Set();
    private lastSyncedTargets: string = "";

    constructor(targetManager: TargetManager, adapter: StreaMonitorAdapter, downloadsManager: DownloadsManager) {
        this.targetManager = targetManager;
        this.adapter = adapter;
        this.downloadsManager = downloadsManager;
        logger.debug("[SC] DiscoveryService initialized (StreaMonitor mode).");
    }

    public start(): void {
        const runLoop = async () => {
            while (true) {
                try {
                    await this.poll();
                } catch (error: any) {
                    logger.error("[SC] Poll error", { error: error.message });
                }
                await timersPromises.setTimeout(5000);
            }
        };
        void runLoop();
    }

    private async poll(): Promise<void> {
        await this.syncTargetsIfChanged();

        const statuses = await this.adapter.pollStatus();
        const recordingUsernames = new Set(
            statuses.filter((s) => s.recording).map((s) => s.username)
        );

        const downloaderPath = path.join(config.getConfig().storagePath, "sc", "downloader");
        const sessionDirs = await this.adapter.findSessionDirs(downloaderPath);

        for (const sessionDir of sessionDirs) {
            if (this.activeSessions.has(sessionDir)) continue;
            if (this.finalizedDirs.has(sessionDir)) continue;

            const parsed = this.adapter.parseSessionDirName(sessionDir);
            if (!parsed) continue;

            const jsonlExists = await FileSystemManager.pathExists(path.join(sessionDir, "segments.jsonl"));
            if (!jsonlExists) continue;

            if (this.downloadsManager.hasStreamer(parsed.username)) continue;

            const existingPlaylist = await FileSystemManager.readFile(path.join(sessionDir, "playlist.m3u8"));
            if (existingPlaylist && existingPlaylist.includes("#EXT-X-ENDLIST")) {
                this.finalizedDirs.add(sessionDir);
                continue;
            }

            logger.info(`[SC] New session detected: ${path.basename(sessionDir)}`);

            const masterUrl = `http://streamonitor-sc/${parsed.username}/${path.basename(sessionDir)}`;
            const handle = this.downloadsManager.add(masterUrl, {
                streamerId: parsed.username,
                alias: parsed.username,
            });
            if (!handle) continue;

            handle.update({ segmentsDirPath: sessionDir });

            const session: ActiveSession = {
                sessionDir,
                username: parsed.username,
                playlistManager: new PlaylistManager(sessionDir),
                jsonlOffset: 0,
                masterUrl,
                headerWritten: false,
                segmentCount: 0,
                trackedSince: Date.now(),
            };

            this.activeSessions.set(sessionDir, session);
            logger.info(`[SC] Started tracking session (resume=${existingSegmentCount > 0}, segs=${existingSegmentCount}): ${path.basename(sessionDir)}`);
        }

        // Tail segments.jsonl for each active session
        for (const [sessionDir, session] of this.activeSessions) {
            await this.processSessionSegments(session);

            const age = Date.now() - session.trackedSince;
            if (!recordingUsernames.has(session.username) && age > FINALIZE_GRACE_MS) {
                await this.processSessionSegments(session);

                if (session.segmentCount > 0) {
                    await session.playlistManager.finalizePlaylist();
                    logger.info(`[SC] Finalized session (${session.segmentCount} segments): ${path.basename(sessionDir)}`);
                } else {
                    logger.warn(`[SC] Session has no segments, skipping finalize: ${path.basename(sessionDir)}`);
                }

                this.finalizedDirs.add(sessionDir);
                this.downloadsManager.remove(session.masterUrl);
                this.activeSessions.delete(sessionDir);
            }
        }
    }

    private async processSessionSegments(session: ActiveSession): Promise<void> {
        const { entries, newOffset } = await this.adapter.readNewSegments(
            session.sessionDir,
            session.jsonlOffset
        );
        if (entries.length === 0) return;
        session.jsonlOffset = newOffset;

        for (const entry of entries) {
            if (entry.init) {
                if (!session.headerWritten) {
                    const playlistPath = path.join(session.sessionDir, "playlist.m3u8");
                    const header =
                        "#EXTM3U\n" +
                        "#EXT-X-VERSION:7\n" +
                        "#EXT-X-TARGETDURATION:3\n" +
                        "#EXT-X-MEDIA-SEQUENCE:0\n" +
                        `#EXT-X-MAP:URI="${entry.name}"\n`;
                    await FileSystemManager.writeFile(playlistPath, header);
                    session.headerWritten = true;
                    logger.info(`[SC] Wrote fMP4 playlist header for ${session.username}`);
                }
                continue;
            }

            if (!session.headerWritten) {
                const playlistPath = path.join(session.sessionDir, "playlist.m3u8");
                const header =
                    "#EXTM3U\n" +
                    "#EXT-X-VERSION:3\n" +
                    "#EXT-X-TARGETDURATION:3\n" +
                    "#EXT-X-MEDIA-SEQUENCE:0\n";
                await FileSystemManager.writeFile(playlistPath, header);
                session.headerWritten = true;
            }

            const segment = {
                remoteUrl: "",
                localName: entry.name,
                metadata: [`#EXTINF:${entry.duration.toFixed(3)},`],
            };
            await session.playlistManager.appendSegmentToPlaylist(segment);
            session.segmentCount++;
        }
    }

    private async syncTargetsIfChanged(): Promise<void> {
        const targets = this.targetManager.getTargets();
        const key = targets.join(",");
        if (key === this.lastSyncedTargets) return;

        this.lastSyncedTargets = key;
        logger.info(`[SC] Syncing ${targets.length} targets to StreaMonitor`);
        await this.adapter.syncTargets(targets);
    }
}
