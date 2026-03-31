import logger from "../../core/logger.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface ScResolvedUser {
    username: string;
    roomId: string;
}

export async function resolveScUsername(username: string): Promise<ScResolvedUser | null> {
    const uniq = Array.from({ length: 16 }, () =>
        "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]
    ).join("");

    const url = `https://stripchat.com/api/front/v2/models/username/${username}/cam?uniq=${uniq}`;

    try {
        const response = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
        });

        if (!response.ok) {
            logger.warn(`[SC] resolveScUsername failed: status=${response.status} username=${username}`);
            return null;
        }

        const data = await response.json() as any;

        if (!data?.user?.user?.id) {
            if (data?.error === "Not Found") {
                logger.warn(`[SC] User ${username} not found`);
            }
            return null;
        }

        const roomId = String(data.user.user.id);
        const currentUsername = data.user.user.username || username;

        return { username: currentUsername, roomId };
    } catch (error: any) {
        logger.error(`[SC] resolveScUsername error: ${username}`, { error: error.message });
        return null;
    }
}
