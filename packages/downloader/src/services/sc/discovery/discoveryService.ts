import * as timersPromises from "timers/promises";
import * as path from "path";
import logger from "../../../common/logger.js";
import * as config from "../../../common/config.js";
import { DownloadsManager } from "../../state/downloadsManager.js";
import { TargetManager } from "../../common/targetManager.js";
import { StreaMonitorAdapter } from "../api/streaMonitorAdapter.js";
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
    hasInitSegment: boolean;
    initSegmentName: string;
    segmentCount: number;
    offlineSince: number | null;
    lastHeartbeat: number;
}

export class ScDiscoveryService {
    private targetManager: TargetManager;
    private adapter: StreaMonitorAdapter;
    private downloadsManager: DownloadsManager;
    // Keyed by username — one active session per streamer
    private activeSessions: Map<string, ActiveSession> = new Map();
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

        if (statuses === null) {
            // API unreachable — keep processing existing sessions but
            // don't start or finalize anything without a reliable signal.
            for (const session of this.activeSessions.values()) {
                await this.processSessionSegments(session);
            }
            return;
        }

        const recordingUsernames = new Set(
            statuses.filter((s) => s.recording).map((s) => s.username)
        );

        const downloaderPath = path.join(config.getConfig().storagePath, "sc", "downloader");

        // --- Start tracking new recordings (API is the authority) ---
        for (const username of recordingUsernames) {
            if (this.activeSessions.has(username)) continue;
            if (this.downloadsManager.hasStreamer(username)) continue;

            const sessionDir = await this.findLatestSessionDir(downloaderPath, username);
            if (!sessionDir) continue; // Dir not created yet — will pick up next poll

            // Finalize stale playlist from prior crash/restart — no resume, clean cut
            const existingPlaylist = path.join(sessionDir, "playlist.m3u8");
            if (await FileSystemManager.pathExists(existingPlaylist)) {
                const content = await FileSystemManager.readFile(existingPlaylist);
                if (content && !content.includes("#EXT-X-ENDLIST")) {
                    logger.info(`[SC] Finalizing stale playlist from prior run: ${path.basename(sessionDir)}`);
                    const pm = new PlaylistManager(sessionDir);
                    await pm.finalizePlaylist();
                    // Skip this dir — next poll will pick up a newer one if still recording
                    continue;
                }
            }

            logger.info(`[SC] New session detected: ${path.basename(sessionDir)}`);

            const masterUrl = `http://streamonitor-sc/${username}/${path.basename(sessionDir)}`;
            const handle = this.downloadsManager.add(masterUrl, {
                streamerId: username,
                alias: username,
            });
            if (!handle) continue;

            handle.update({ segmentsDirPath: sessionDir });

            const session: ActiveSession = {
                sessionDir,
                username,
                playlistManager: new PlaylistManager(sessionDir),
                jsonlOffset: 0,
                masterUrl,
                headerWritten: false,
                hasInitSegment: false,
                initSegmentName: "",
                segmentCount: 0,
                offlineSince: null,
                lastHeartbeat: Date.now(),
            };

            this.activeSessions.set(username, session);
            logger.info(`[SC] Started tracking session: ${path.basename(sessionDir)}`);
        }

        // --- Process segments and finalize offline sessions ---
        for (const [username, session] of this.activeSessions) {
            await this.processSessionSegments(session);

            // Heartbeat every 30s
            if (Date.now() - session.lastHeartbeat >= 30_000) {
                const offlineSec = session.offlineSince ? Math.round((Date.now() - session.offlineSince) / 1000) : 0;
                logger.debug(`[SC-DEBUG] HEARTBEAT ${username} segments=${session.segmentCount} offlineSec=${offlineSec} dir=${path.basename(session.sessionDir)}`);
                session.lastHeartbeat = Date.now();
            }

            if (recordingUsernames.has(username)) {
                // Still recording — reset offline timer
                session.offlineSince = null;
                continue;
            }

            // Not recording — start or continue grace period
            if (session.offlineSince === null) {
                session.offlineSince = Date.now();
            }

            if (Date.now() - session.offlineSince > FINALIZE_GRACE_MS) {
                // Final drain before closing
                await this.processSessionSegments(session);

                if (session.segmentCount > 0) {
                    await session.playlistManager.finalizePlaylist();
                    logger.info(`[SC] Finalized session (${session.segmentCount} segments): ${path.basename(session.sessionDir)}`);
                } else {
                    logger.warn(`[SC] Session has no segments, skipping finalize: ${path.basename(session.sessionDir)}`);
                }

                this.downloadsManager.remove(session.masterUrl);
                this.activeSessions.delete(username);
            }
        }
    }

    /**
     * Find the latest non-finalized session directory for a username.
     */
    private async findLatestSessionDir(downloaderPath: string, username: string): Promise<string | null> {
        const allDirs = await this.adapter.findSessionDirs(downloaderPath);
        const matching = allDirs
            .filter((dir) => {
                const parsed = this.adapter.parseSessionDirName(dir);
                return parsed && parsed.username === username;
            })
            // Alphabetical sort works because format is "YYYY-MM-DD HHMMSS username"
            .sort()
            .reverse();

        // Find the latest non-finalized dir (disk is truth)
        for (const dir of matching) {
            const playlistPath = path.join(dir, "playlist.m3u8");
            if (await FileSystemManager.pathExists(playlistPath)) {
                const content = await FileSystemManager.readFile(playlistPath);
                if (content && content.includes("#EXT-X-ENDLIST")) {
                    continue; // Already finalized
                }
            }
            return dir;
        }
        return null;
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
                session.hasInitSegment = true;
                session.initSegmentName = entry.name;
                continue;
            }

            // Write header on first real segment so we know the actual duration
            if (!session.headerWritten) {
                const targetDuration = Math.ceil(entry.duration);
                const playlistPath = path.join(session.sessionDir, "playlist.m3u8");
                const lines = [
                    "#EXTM3U",
                    session.hasInitSegment ? "#EXT-X-VERSION:7" : "#EXT-X-VERSION:3",
                    `#EXT-X-TARGETDURATION:${targetDuration}`,
                    "#EXT-X-MEDIA-SEQUENCE:0",
                ];
                if (session.hasInitSegment) {
                    lines.push(`#EXT-X-MAP:URI="${session.initSegmentName}"`);
                }
                await FileSystemManager.writeFile(playlistPath, lines.join("\n") + "\n");
                session.headerWritten = true;
                logger.info(`[SC] Wrote playlist header for ${session.username} (targetDuration=${targetDuration})`);
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

        logger.info(`[SC] Syncing ${targets.length} targets to StreaMonitor`);
        const ok = await this.adapter.syncTargets(targets);
        if (ok) {
            this.lastSyncedTargets = key;
        }
    }
}
