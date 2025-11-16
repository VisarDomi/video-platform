import * as fsPromises from "fs/promises";
import * as path from "path";

import logger from "../common/logger.js";
import * as constants from "../common/constants.js";
import * as config from "../common/config.js";
import * as types from "../common/types.js";

import { RefreshResult, TokenDataResult } from "./authClient.js";

interface SessionData {
    tangoRT: string | null;
    tangoST: string | null;
    tt: string | null;
    ttu: string | null;
    tte: string | null;
}

export class AuthContext {
    private readonly email: string;
    private tangoRT: string | null = null;
    private tangoST: string | null = null;
    private tt: string | null = null;
    private ttu: string | null = null;
    private tte: string | null = null;

    constructor(email: string) {
        this.email = email;
    }

    public getTangoRT(): string | null {
        return this.tangoRT;
    }
    public getTangoST(): string | null {
        return this.tangoST;
    }
    public getTt(): string | null {
        return this.tt;
    }
    public getTtu(): string | null {
        return this.ttu;
    }
    public getTte(): string | null {
        return this.tte;
    }

    public updateFromRefresh(result: RefreshResult): boolean {
        this.tangoST = result.newTangoST;
        if (result.newTangoRT) {
            this.tangoRT = result.newTangoRT;
            return true;
        }
        return false;
    }

    public updateFromTokenData(result: TokenDataResult): void {
        this.tt = result.tt;
        this.ttu = result.ttu;
        this.tte = result.tte;
    }

    public updateFromLogin(result: types.LoginResult): void {
        this.tangoRT = result.tangoRT;
        this.tangoST = result.tangoST;
    }

    public getApiHeaders(): HeadersInit {
        if (!this.tangoST) {
            throw new Error(`Cannot create API headers for ${this.email}: Tango-ST is missing.`);
        }
        return { [constants.HEADERS.COOKIE]: `${constants.COOKIE_NAMES.TANGO_ST_PREFIX}${this.tangoST}` };
    }

    public getStreamHeaders(): HeadersInit {
        if (!this.tt || !this.ttu || !this.tte) {
            throw new Error(`Cannot create stream headers for ${this.email}: tt, ttu, or tte are missing.`);
        }
        const cookie = `tt=${this.tt};ttu=${this.ttu};tte=${this.tte}`;
        return { [constants.HEADERS.COOKIE]: cookie };
    }

    private getSessionFilePath(): string {
        const sessionFilename = `${this.email}.json`;
        return path.resolve(config.getConfig().sessionPath, sessionFilename);
    }

    public async loadTokenFromFile(): Promise<boolean> {
        const filePath = this.getSessionFilePath();
        try {
            const data = await fsPromises.readFile(filePath, "utf-8");
            const session: Partial<SessionData> = JSON.parse(data);

            if (session.tangoRT) {
                this.tangoRT = session.tangoRT;
                this.tangoST = session.tangoST ?? null;
                this.tt = session.tt ?? null;
                this.ttu = session.ttu ?? null;
                this.tte = session.tte ?? null;
                return true;
            }
        } catch (error: any) {
            if (error.code !== "ENOENT") {
                logger.error(`Failed to read session file for ${this.email} at ${filePath}`, { error });
            }
        }
        return false;
    }

    public async saveTokenToFile(): Promise<void> {
        const filePath = this.getSessionFilePath();
        try {
            if (this.tangoRT) {
                const sessionData: SessionData = {
                    tangoRT: this.tangoRT,
                    tangoST: this.tangoST,
                    tt: this.tt,
                    ttu: this.ttu,
                    tte: this.tte,
                };
                await fsPromises.writeFile(filePath, JSON.stringify(sessionData, null, 2));
                logger.verbose(`Session tokens for ${this.email} saved to ${path.basename(filePath)}`);
            }
        } catch (error) {
            logger.error(`Failed to save session file for ${this.email} at ${filePath}`, { error });
        }
    }
}