import logger from "../../core/logger.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface ScResolvedUser {
    username: string;
    roomId: string;
}

const userIdsUrl = (username: string) => `https://stripchat.com/api/front/users/user-ids/${encodeURIComponent(username)}`;

export async function resolveScUsername(username: string): Promise<ScResolvedUser | null> {
    const normalizedUsername = username.trim();
    const url = userIdsUrl(normalizedUsername);

    try {
        const response = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
        });

        if (!response.ok) {
            // 404 is Stripchat's "no such user", an ordinary answer to a lookup.
            logger.log(response.status === 404 ? "debug" : "warn", `[SC] resolveScUsername failed: status=${response.status} username=${username}`);
            return null;
        }

        const data = await response.json() as any;

        if (!data?.id) {
            logger.warn(`[SC] User ${username} not found`);
            return null;
        }

        // An old username still resolves, naming the current one.
        return { username: typeof data.newUsername === "string" && data.newUsername.trim() || normalizedUsername, roomId: String(data.id) };
    } catch (error: any) {
        logger.error(`[SC] resolveScUsername error: ${username}`, { error: error.message });
        return null;
    }
}

// Whether Stripchat knows a model by this username (old usernames still resolve). Throws when
// Stripchat cannot answer, so a failed lookup never reads as "no such streamer".
export async function scUsernameExists(username: string): Promise<boolean> {
    const response = await fetch(userIdsUrl(username.trim()), { headers: { "User-Agent": USER_AGENT } });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Stripchat lookup failed: ${response.status}`);
    const data = await response.json() as { id?: unknown } | null;
    return Boolean(data?.id);
}
