import * as timersPromises from "timers/promises";
import * as path from "path";

import * as config from "../../common/config.js";
import logger from "../../common/logger.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";

export interface Tokens {
    st: string | null;
    tt: string | null;
    ttu: string | null;
    tte: string | null;
}

export class TokenManager {
    private tokens: Tokens | null = null;

    private constructor() {
        logger.info("TokenManager initialized.");
    }

    public static async create(): Promise<TokenManager> {
        const instance = new TokenManager();
        await instance._loadTokens();
        return instance;
    }

    public startTokenWatcher(): void {
        const watch = async () => {
            const refreshInterval = config.getConfig().intervals.shortTokenRefresh;
            await timersPromises.setTimeout(refreshInterval);
            while (true) {
                await this._loadTokens();
                await timersPromises.setTimeout(refreshInterval);
            }
        };
        void watch();
    }

    private async _loadTokens(): Promise<boolean> {
        const cfg = config.getConfig();
        const sessionFilePath = path.resolve(cfg.sharedStatePath, "session", "diusminus@gmail.com.json");
        const session = await FileSystemManager.readJsonFile<any>(sessionFilePath);

        if (!session) {
            if (this.tokens) {
                logger.warn("Tokens became invalid: session.json not found or is invalid.");
            }
            this.tokens = null;
            return false;
        }

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
    }

    public async getTokens(): Promise<Tokens> {
        while (!this.tokens) {
            logger.warn("Tokens not available. Waiting for session.json to be populated...");
            const loaded = await this._loadTokens();
            if (!loaded) {
                await timersPromises.setTimeout(5000); // wait 5s before retrying
            }
        }
        return this.tokens;
    }
}
