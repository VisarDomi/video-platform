import * as fsPromises from "fs/promises";
import * as path from "path";

import logger from "../common/logger.js";
import * as config from "../common/config.js";
import { IAuthProvider, TokenBag, RefreshResult, ShortTokenResult } from "../providers/interfaces.js";

export class AuthContext {
    private readonly email: string;
    private readonly provider: IAuthProvider;
    private tokenBag: TokenBag | null = null;

    constructor(email: string, provider: IAuthProvider) {
        this.email = email;
        this.provider = provider;
    }

    public getRefreshToken(): string | null {
        return this.tokenBag?.refreshToken ?? null;
    }

    public getSessionToken(): string | null {
        return this.tokenBag?.sessionToken ?? null;
    }

    public getTokenBag(): TokenBag | null {
        return this.tokenBag;
    }

    public updateFromRefresh(result: RefreshResult): boolean {
        if (!this.tokenBag) return false;
        this.tokenBag.sessionToken = result.newSessionToken;
        if (result.newRefreshToken) {
            this.tokenBag.refreshToken = result.newRefreshToken;
            return true;
        }
        return false;
    }

    public updateFromTokenData(result: ShortTokenResult): void {
        if (!this.tokenBag) return;
        this.tokenBag.extras = { ...this.tokenBag.extras, ...result.extras };
    }

    public updateFromLogin(bag: TokenBag): void {
        this.tokenBag = bag;
    }

    private getSessionFilePath(): string {
        const sessionFilename = `${this.email}.json`;
        return path.resolve(config.getConfig().sessionPath, sessionFilename);
    }

    public async loadTokenFromFile(): Promise<boolean> {
        const filePath = this.getSessionFilePath();
        try {
            const data = await fsPromises.readFile(filePath, "utf-8");
            const parsed = JSON.parse(data);
            const bag = this.provider.deserializeTokens(parsed);

            if (bag) {
                this.tokenBag = bag;
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
            if (this.tokenBag) {
                const serialized = this.provider.serializeTokens(this.tokenBag);
                serialized.lastWriteMs = Date.now();
                const tmpPath = filePath + '.tmp';
                await fsPromises.writeFile(tmpPath, JSON.stringify(serialized, null, 2));
                await fsPromises.rename(tmpPath, filePath);
                logger.verbose(`Session tokens for ${this.email} saved to ${path.basename(filePath)}`);
            }
        } catch (error) {
            logger.error(`Failed to save session file for ${this.email} at ${filePath}`, { error });
        }
    }
}
