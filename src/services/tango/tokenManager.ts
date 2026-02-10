import fs from "fs/promises";
import path from "path";
import os from "os";
import logger from "../../core/logger.js";
import { DIRECTORIES } from "../../core/constants.js";

export interface Tokens {
    st: string | null;
}

const SESSION_FILE = path.join(
    os.homedir(),
    DIRECTORIES.SHARED_STATE_BASE,
    "session",
    "diusminus@gmail.com.json"
);

let tokens: Tokens | null = null;

async function loadTokens(): Promise<boolean> {
    try {
        const content = await fs.readFile(SESSION_FILE, "utf-8");
        const session = JSON.parse(content);
        if (session.tangoST) {
            tokens = { st: session.tangoST };
            return true;
        }
        logger.warn("[TL] Token load failed: session.json is missing tangoST.");
        tokens = null;
        return false;
    } catch {
        tokens = null;
        return false;
    }
}

export function startTokenWatcher(): void {
    void loadTokens();
    setInterval(() => void loadTokens(), 5000);
}

export function getTokens(): Tokens | null {
    return tokens;
}
