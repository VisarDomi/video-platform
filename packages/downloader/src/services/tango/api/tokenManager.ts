import * as path from "path";

import { config } from "../../../common/config.js";
import logger from "../../../common/logger.js";
import { FileSystemManager } from "../../../common/fileSystemManager.js";

export interface Tokens {
    st: string | null;
    tt: string | null;
    ttu: string | null;
    tte: string | null;
}

export class TokenManager {
    private readonly sessionFilePath: string;

    constructor() {
        this.sessionFilePath = path.resolve(config.sharedStatePath, "session", "diusminus@gmail.com.json");
    }

    public async getTokens(): Promise<Tokens> {
        const session = await FileSystemManager.readJsonFile<any>(this.sessionFilePath);

        if (!session) {
            logger.warn("[Tango] session.json not found or invalid");
            return { st: null, tt: null, ttu: null, tte: null };
        }

        return {
            st: session.tangoST ?? null,
            tt: session.tt ?? null,
            ttu: session.ttu ?? null,
            tte: session.tte ?? null,
        };
    }

}
