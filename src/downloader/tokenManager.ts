// src/common/tokenManager.ts
import * as fsPromises from "fs/promises";
import * as timersPromises from "timers/promises";
import * as path from "path";

import * as config from "../common/config.js";
import logger from "../common/logger.js";
import * as requests from "../downloader/requests.js";

export class TokenManager {
    private tokens: requests.Tokens | null = null;

    /**
     * The constructor is now private. Use the async `create` method instead.
     */
    private constructor() {
        logger.info("TokenManager initialized.");
    }

    /**
     * Asynchronously creates and initializes a TokenManager, performing an initial token load.
     */
    public static async create(): Promise<TokenManager> {
        const instance = new TokenManager();
        await instance._loadTokens();
        return instance;
    }

    /**
     * Starts a background process to periodically refresh tokens from the session file.
     */
    public startWatcher(): void {
        const watch = async () => {
            const refreshInterval = config.getConfig().intervals.shortTokenRefresh;
            await timersPromises.setTimeout(refreshInterval);
            while (true) {
                await this._loadTokens();
                await timersPromises.setTimeout(refreshInterval);
            }
        };
        watch(); // Fire-and-forget
    }

    /**
     * Returns the currently loaded tokens.
     */
    public getTokens(): requests.Tokens | null {
        return this.tokens;
    }

    private async _loadTokens(): Promise<boolean> {
        try {
            const cfg = config.getConfig();
            const sessionFilePath = path.resolve(cfg.sharedStatePath, "session.json");
            const data = await fsPromises.readFile(sessionFilePath, "utf-8");
            const session = JSON.parse(data);

            if (session.tangoST && session.tt && session.ttu && session.tte) {
                this.tokens = {
                    st: session.tangoST,
                    tt: session.tt,
                    ttu: session.ttu,
                    tte: session.tte,
                };
                return true;
            } else {
                logger.warn("Token load failed: session.json is missing required tokens.");
                this.tokens = null;
                return false;
            }
        } catch (error: any) {
            if (error.code === "ENOENT") {
                logger.warn("Token load failed: session.json not found.");
            } else {
                logger.error("Failed to read tokens from session file", { error });
            }
            this.tokens = null;
            return false;
        }
    }
}
