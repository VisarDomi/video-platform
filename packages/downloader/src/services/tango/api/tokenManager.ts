import * as timersPromises from "timers/promises";
import * as path from "path";

import * as config from "../../../common/config.js";
import logger from "../../../common/logger.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";

export interface Tokens {
    st: string | null;
    tt: string | null;
    ttu: string | null;
    tte: string | null;
}

/**
 * Minimum remaining TTL (seconds) before we consider stream tokens usable.
 * If tte is closer than this to now, we force a reload from disk rather
 * than sending tokens the CDN will reject.
 */
const MIN_TTL_SECONDS = 3;

export class TokenManager {
    private tokens: Tokens | null = null;

    private constructor() {
        logger.info("[Tango] TokenManager initialized.");
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
                logger.warn("[Tango] Tokens became invalid: session.json not found or is invalid.");
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
            logger.warn("[Tango] Token load failed: session.json is missing required tokens.");
            this.tokens = null;
            return false;
        }
    }

    private streamTokenTtl(): number {
        if (!this.tokens?.tte) return -1;
        const tte = parseInt(this.tokens.tte, 10);
        if (isNaN(tte)) return -1;
        return tte - Math.floor(Date.now() / 1000);
    }

    public async getTokens(): Promise<Tokens> {
        while (!this.tokens) {
            logger.warn("[Tango] Tokens not available. Waiting for session.json to be populated...");
            const loaded = await this._loadTokens();
            if (!loaded) {
                await timersPromises.setTimeout(5000);
            }
        }

        const ttl = this.streamTokenTtl();
        if (ttl < MIN_TTL_SECONDS) {
            logger.warn(`[Tango] Stream tokens near expiry (ttl=${ttl}s), forcing reload`);
            const loaded = await this._loadTokens();
            if (loaded) {
                const newTtl = this.streamTokenTtl();
                if (newTtl < MIN_TTL_SECONDS) {
                    logger.error(`[Tango] Stream tokens STILL near expiry after reload (ttl=${newTtl}s) — auth service may be stalled`);
                }
            }
        }

        return this.tokens!;
    }
}
