import { promises as fs } from "fs";
import { SC_FILE_PATH } from "../core/config.js";
import logger from "../core/logger.js";

const SC_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const SC_BATCH_CHUNK_SIZE = 100;
const SC_PREFIX = "https://stripchat.com/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface ScEntry {
    roomId: string;
    username: string;
}

function parseEntry(line: string): ScEntry | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(SC_PREFIX)) return null;

    const rest = trimmed.slice(SC_PREFIX.length);
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return null;

    const username = rest.slice(0, spaceIdx).replace(/\/$/, "");
    const roomId = rest.slice(spaceIdx + 1).trim();
    if (!username || !roomId) return null;
    return { roomId, username };
}

async function fetchCurrentUsernames(roomIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    for (let i = 0; i < roomIds.length; i += SC_BATCH_CHUNK_SIZE) {
        const batch = roomIds.slice(i, i + SC_BATCH_CHUNK_SIZE);
        const params = batch.map((id) => `modelIds[]=${encodeURIComponent(id)}`).join("&");
        try {
            const response = await fetch(`https://stripchat.com/api/front/models/list?${params}`, {
                headers: { "User-Agent": USER_AGENT },
            });
            if (!response.ok) continue;

            const data = await response.json() as { models?: Array<{ id?: number | string; username?: string }> };
            for (const model of data.models ?? []) {
                const roomId = model.id !== undefined ? String(model.id) : "";
                const username = model.username?.trim();
                if (roomId && username) {
                    result.set(roomId, username);
                }
            }
        } catch (error: any) {
            logger.error("[SC Alias Refresh] Batch fetch failed", { error: error.message });
        }
    }

    return result;
}

async function syncScTxtAliases(): Promise<void> {
    let content: string;
    try {
        content = await fs.readFile(SC_FILE_PATH, "utf-8");
    } catch {
        return;
    }

    const lines = content.split("\n");
    const entries = lines.map(parseEntry);
    const roomIds = entries
        .filter((entry): entry is ScEntry => entry !== null)
        .map((entry) => entry.roomId);

    if (roomIds.length === 0) return;

    const usernameMap = await fetchCurrentUsernames(roomIds);
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
        const entry = entries[i];
        if (!entry) continue;

        const latestUsername = usernameMap.get(entry.roomId);
        if (!latestUsername || latestUsername === entry.username) continue;

        lines[i] = `${SC_PREFIX}${latestUsername} ${entry.roomId}`;
        changed = true;
        logger.info(`[SC Alias Refresh] sc.txt sync: ${entry.roomId} ${entry.username} -> ${latestUsername}`);
    }

    if (changed) {
        await fs.writeFile(SC_FILE_PATH, lines.join("\n"), "utf-8");
    }
}

export function startScAliasRefresh(): void {
    const run = async () => {
        try {
            await syncScTxtAliases();
        } catch (error: any) {
            logger.error("[SC Alias Refresh] Periodic refresh failed", { error: error.message });
        }
    };

    void run();
    setInterval(() => {
        void run();
    }, SC_REFRESH_INTERVAL_MS);
}
