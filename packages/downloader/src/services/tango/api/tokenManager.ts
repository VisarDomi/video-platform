import * as timersPromises from "timers/promises";
import * as fsPromises from "fs/promises";
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
 * Maximum age (ms) of the session file before we consider the auth
 * service stalled. The auth service writes every 5s (shortTokenRefresh).
 * Two missed cycles = something is wrong.
 */
const AUTH_STALE_THRESHOLD_MS = 15_000;

export class TokenManager {
    private tokens: Tokens | null = null;
    private sessionFilePath: string;
    private authStaleLogged = false;

    private constructor() {
        const cfg = config.getConfig();
        this.sessionFilePath = path.resolve(cfg.sharedStatePath, "session", "diusminus@gmail.com.json");
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
                this._checkAuthHealth();
                await timersPromises.setTimeout(refreshInterval);
            }
        };
        void watch();
    }

    private async _loadTokens(): Promise<boolean> {
        const session = await FileSystemManager.readJsonFile<any>(this.sessionFilePath);

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

    /**
     * Check if the auth service is alive by looking at the session file's
     * mtime. The auth service is the sole writer — if the file is stale,
     * the auth service stopped refreshing and our tokens will expire.
     * Logs once on detection, clears when the file is fresh again.
     */
    private _checkAuthHealth(): void {
        fsPromises.stat(this.sessionFilePath).then((stat) => {
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs > AUTH_STALE_THRESHOLD_MS) {
                if (!this.authStaleLogged) {
                    logger.error(`[Tango] Auth service stale — session file age=${(ageMs / 1000).toFixed(0)}s (threshold=${AUTH_STALE_THRESHOLD_MS / 1000}s). Stream tokens will expire.`);
                    this.authStaleLogged = true;
                }
            } else {
                if (this.authStaleLogged) {
                    logger.info(`[Tango] Auth service recovered — session file fresh (age=${(ageMs / 1000).toFixed(0)}s)`);
                }
                this.authStaleLogged = false;
            }
        }).catch(() => {
            // stat failed — _loadTokens already handles missing file
        });
    }

    public async getTokens(): Promise<Tokens> {
        while (!this.tokens) {
            logger.warn("[Tango] Tokens not available. Waiting for session.json to be populated...");
            const loaded = await this._loadTokens();
            if (!loaded) {
                await timersPromises.setTimeout(5000);
            }
        }
        return this.tokens;
    }
}
