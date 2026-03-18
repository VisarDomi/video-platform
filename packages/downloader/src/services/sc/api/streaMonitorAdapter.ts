import * as fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import { createReadStream } from "fs";
import logger from "../../../common/logger.js";

const STREAMONITOR_API = "http://127.0.0.1:17444";

interface StreamerStatus {
    username: string;
    recording: boolean;
    status: string;
    running: boolean;
}

export interface SegmentEntry {
    name: string;
    duration: number;
    init?: boolean;
}

export class StreaMonitorAdapter {
    constructor() {
        logger.debug("[SC] StreaMonitorAdapter initialized.");
    }

    /**
     * Poll /api/data to get all streamer statuses.
     */
    public async pollStatus(): Promise<StreamerStatus[] | null> {
        try {
            const response = await fetch(`${STREAMONITOR_API}/api/data`, {
                headers: { Authorization: "Basic " + Buffer.from("admin:admin").toString("base64") },
            });
            if (!response.ok) {
                logger.warn(`[SC] StreaMonitor API returned ${response.status}`);
                return null;
            }
            const data = await response.json() as any;
            return (data.streamers || []).map((s: any) => ({
                username: s.username,
                recording: s.recording,
                status: s.status,
                running: s.running,
            }));
        } catch (error: any) {
            logger.error(`[SC] Failed to poll StreaMonitor`, { error: error.message });
            return null;
        }
    }

    /**
     * Sync targets from sc.txt to StreaMonitor via the command API.
     * Adds missing streamers, removes extras.
     */
    public async syncTargets(targets: string[]): Promise<void> {
        const statuses = await this.pollStatus();
        if (!statuses) return;
        const existing = new Set(statuses.map((s) => s.username));
        const desired = new Set(targets);

        // Add missing
        for (const username of desired) {
            if (!existing.has(username)) {
                await this.executeCommand(`add ${username} StripChat`);
                logger.info(`[SC] Added ${username} to StreaMonitor`);
            }
        }

        // Remove extras
        for (const username of existing) {
            if (!desired.has(username)) {
                await this.executeCommand(`remove ${username} StripChat`);
                logger.info(`[SC] Removed ${username} from StreaMonitor`);
            }
        }
    }

    /**
     * Execute a command via StreaMonitor's /api/command endpoint.
     */
    private async executeCommand(command: string): Promise<string> {
        try {
            const url = `${STREAMONITOR_API}/api/command?command=${encodeURIComponent(command)}`;
            const response = await fetch(url, {
                headers: { Authorization: "Basic " + Buffer.from("admin:admin").toString("base64") },
            });
            return await response.text();
        } catch (error: any) {
            logger.error(`[SC] Command failed: ${command}`, { error: error.message });
            return "";
        }
    }

    /**
     * Find new session directories in the downloads folder.
     * Session dirs match pattern: YYYY-MM-DD HHMMSS username
     */
    public async findSessionDirs(downloaderPath: string): Promise<string[]> {
        try {
            const entries = await fs.readdir(downloaderPath, { withFileTypes: true });
            return entries
                .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2} \d{6} /.test(e.name))
                .map((e) => path.join(downloaderPath, e.name));
        } catch {
            return [];
        }
    }

    /**
     * Extract the username from a session directory name.
     * Format: "YYYY-MM-DD HHMMSS username"
     */
    public parseSessionDirName(dirPath: string): { username: string; timestamp: string } | null {
        const dirName = path.basename(dirPath);
        const match = dirName.match(/^(\d{4}-\d{2}-\d{2} \d{6}) (.+)$/);
        if (!match) return null;
        return { timestamp: match[1], username: match[2] };
    }

    /**
     * Read new segment entries from segments.jsonl starting at a byte offset.
     * Returns the new entries and the updated offset.
     */
    public async readNewSegments(
        sessionDir: string,
        fromOffset: number
    ): Promise<{ entries: SegmentEntry[]; newOffset: number }> {
        const jsonlPath = path.join(sessionDir, "segments.jsonl");
        const entries: SegmentEntry[] = [];

        try {
            const stat = await fs.stat(jsonlPath);
            if (stat.size <= fromOffset) {
                return { entries, newOffset: fromOffset };
            }
        } catch {
            return { entries, newOffset: fromOffset };
        }

        // Read from offset
        const fileHandle = await fs.open(jsonlPath, "r");
        try {
            const buf = Buffer.alloc(1024 * 64); // 64KB read buffer
            let bytesRead = 0;
            let currentOffset = fromOffset;
            let partial = "";

            while (true) {
                const result = await fileHandle.read(buf, 0, buf.length, currentOffset);
                if (result.bytesRead === 0) break;
                bytesRead = result.bytesRead;

                const chunk = partial + buf.subarray(0, bytesRead).toString("utf-8");
                const lines = chunk.split("\n");

                // Last element may be partial line
                partial = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const entry = JSON.parse(trimmed) as SegmentEntry;
                        entries.push(entry);
                    } catch {
                        logger.warn(`[SC] Failed to parse segments.jsonl line: ${trimmed}`);
                    }
                }

                currentOffset += bytesRead;
            }

            // Final offset: don't count partial line
            const newOffset = currentOffset - Buffer.byteLength(partial, "utf-8");
            return { entries, newOffset };
        } finally {
            await fileHandle.close();
        }
    }
}
