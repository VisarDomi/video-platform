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
 * Stream token TTL is 10s. Auth refresh cycle is 5s.
 * A freshly-read token should have 5-10s remaining.
 * Below this threshold means the auth cycle lagged.
 */
const STREAM_TOKEN_TTL = 10;
const AUTH_REFRESH_CYCLE = 5;
const EXPECTED_MIN_TTL = STREAM_TOKEN_TTL - AUTH_REFRESH_CYCLE;

/** Auth file older than 3 missed cycles = auth service is dead. */
const AUTH_STALE_THRESHOLD_MS = AUTH_REFRESH_CYCLE * 3 * 1000;

export class TokenManager {
    private tokens: Tokens | null = null;
    private sessionFilePath: string;
    private authStaleLogged = false;
    private lastTte: string | null = null;
    private lastLoadedAt: number = 0;

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
            const newTte = session.tte;
            const ttlAtRead = parseInt(newTte, 10) - Math.floor(Date.now() / 1000);

            if (this.lastTte !== null && newTte === this.lastTte && ttlAtRead < EXPECTED_MIN_TTL) {
                logger.warn(`[Tango] Token tte unchanged across reads (ttl=${ttlAtRead}s) — auth may be stuck`);
            }

            if (ttlAtRead < EXPECTED_MIN_TTL && this.lastTte !== newTte) {
                let fileMtimeInfo = "";
                try {
                    const stat = await fsPromises.stat(this.sessionFilePath);
                    const ageMs = Date.now() - stat.mtimeMs;
                    fileMtimeInfo = ` fileAge=${(ageMs / 1000).toFixed(1)}s`;
                } catch {}
                logger.warn(`[Tango] Token near-expiry at read time: ttl=${ttlAtRead}s (expected>=${EXPECTED_MIN_TTL}s)${fileMtimeInfo}`);
            }

            this.lastTte = newTte;
            this.lastLoadedAt = Date.now();

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
        }).catch(() => {});
    }

    public get tokenAgeMs(): number {
        return this.lastLoadedAt > 0 ? Date.now() - this.lastLoadedAt : -1;
    }

    public static get expectedMinTtl(): number {
        return EXPECTED_MIN_TTL;
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
