import * as path from "path";

import { config } from "../../../common/config.js";
import logger from "../../../common/logger.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";

export interface Tokens {
    st: string | null;
    tt: string | null;
    ttu: string | null;
    tte: string | null;
    /** Epoch ms when these tokens were read from disk */
    readAtMs: number;
    /** Seconds until tte expiry, computed at read time. Negative = already expired on disk. null = tte missing/unparseable. */
    ttlAtReadSec: number | null;
    /** Ms since auth service last wrote this token to disk. null = lastWriteMs missing from file. */
    tokenAgeMs: number | null;
}

export class TokenManager {
    private readonly sessionFilePath: string;

    constructor() {
        this.sessionFilePath = path.resolve(config.sharedStatePath, "session", "diusminus@gmail.com.json");
    }

    public async getTokens(): Promise<Tokens> {
        const readAtMs = Date.now();
        const session = await FileSystemManager.readJsonFile<any>(this.sessionFilePath);

        if (!session) {
            logger.warn("[Tango] session.json not found or invalid");
            return { st: null, tt: null, ttu: null, tte: null, readAtMs, ttlAtReadSec: null, tokenAgeMs: null };
        }

        const tte: string | null = session.tte ?? null;
        let ttlAtReadSec: number | null = null;
        const lastWriteMs: number | null = session.lastWriteMs ?? null;
        const tokenAgeMs = lastWriteMs !== null ? readAtMs - lastWriteMs : null;

        if (tte) {
            const parsed = parseInt(tte, 10);
            if (!isNaN(parsed)) {
                ttlAtReadSec = parsed - Math.floor(readAtMs / 1000);
                if (ttlAtReadSec <= 0) {
                    logger.warn(`[Tango] Token already expired at read time: ttl=${ttlAtReadSec}s tokenAge=${tokenAgeMs}ms tte=${tte}`);
                }
            }
        }

        return {
            st: session.tangoST ?? null,
            tt: session.tt ?? null,
            ttu: session.ttu ?? null,
            tte,
            readAtMs,
            ttlAtReadSec,
            tokenAgeMs,
        };
    }

}
