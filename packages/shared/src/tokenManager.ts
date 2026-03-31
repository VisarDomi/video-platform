import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

const SESSION_DIR = path.join(os.homedir(), ".local", "share", "video-services", "session");
const SESSION_FILE = path.join(SESSION_DIR, "diusminus@gmail.com.json");

export interface Tokens {
    st: string | null;
    tt: string | null;
    ttu: string | null;
    tte: string | null;
    readAtMs: number;
    ttlAtReadSec: number | null;
    tokenAgeMs: number | null;
}

export async function readTokens(): Promise<Tokens> {
    const readAtMs = Date.now();
    const empty: Tokens = { st: null, tt: null, ttu: null, tte: null, readAtMs, ttlAtReadSec: null, tokenAgeMs: null };

    let raw: string;
    try {
        raw = await fs.readFile(SESSION_FILE, "utf-8");
    } catch {
        return empty;
    }

    let session: any;
    try {
        session = JSON.parse(raw);
    } catch {
        return empty;
    }

    if (!session.tangoST) return empty;

    const tte: string | null = session.tte ?? null;
    const lastWriteMs: number | null = session.lastWriteMs ?? null;
    const tokenAgeMs = lastWriteMs !== null ? readAtMs - lastWriteMs : null;

    let ttlAtReadSec: number | null = null;
    if (tte) {
        const parsed = parseInt(tte, 10);
        if (!isNaN(parsed)) {
            ttlAtReadSec = parsed - Math.floor(readAtMs / 1000);
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
