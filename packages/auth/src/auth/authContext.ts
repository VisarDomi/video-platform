import * as path from "path";

import type { SessionRenewal, ShortTokens, SiteAuth, TokenBag } from "sdk";
import { CredentialStore } from "shared";
import logger from "../common/logger.js";
import { getConfig } from "../common/config.js";

// One account's session in memory, and its saves to the core's credential store
// (session/<email>.json, read by every consumer of the site's credentials).
export class AuthContext {
    private readonly email: string;
    private readonly provider: SiteAuth;
    private readonly store: CredentialStore;
    private tokenBag: TokenBag | null = null;
    private tokenSave: Promise<void> = Promise.resolve();

    constructor(email: string, provider: SiteAuth, store: CredentialStore = new CredentialStore(getConfig().sessionPath)) {
        this.email = email;
        this.provider = provider;
        this.store = store;
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

    public updateFromRefresh(result: SessionRenewal): boolean {
        if (!this.tokenBag) return false;
        // A request using the previous ST must not attach its late stream tokens
        // to this generation. AuthService checks this immutable owner identity.
        this.tokenBag = { ...this.tokenBag, sessionToken: result.newSessionToken,
            refreshToken: result.newRefreshToken ?? this.tokenBag.refreshToken,
            extras: { ...this.tokenBag.extras, ...result.extras } };
        return !!result.newRefreshToken;
    }

    public updateFromTokenData(result: ShortTokens): void {
        if (!this.tokenBag) return;
        this.tokenBag.extras = { ...this.tokenBag.extras, ...result.extras };
    }

    public updateFromLogin(bag: TokenBag): void {
        this.tokenBag = bag;
    }

    public async loadTokenFromFile(): Promise<boolean> {
        try {
            const record = await this.store.load(this.email);
            const bag = record ? this.provider.deserializeTokens(record) : null;

            if (bag) {
                this.tokenBag = bag;
                return true;
            }
        } catch (error: any) {
            logger.error(`Failed to read session file for ${this.email} at ${this.store.path(this.email)}`, { error });
        }
        return false;
    }

    public saveTokenToFile(): Promise<void> {
        // The session and stream refresh loops can save at the same time.
        // Commit in order so neither steals the other's temporary file or
        // overwrites a newly rotated refresh token with an older snapshot.
        this.tokenSave = this.tokenSave.catch(() => {}).then(() => this.persistTokenToFile());
        return this.tokenSave;
    }

    private async persistTokenToFile(): Promise<void> {
        const filePath = this.store.path(this.email);
        try {
            if (this.tokenBag) {
                // The bag as it is when this save runs (a later rotation is saved by a later
                // save), durable when it resolves: the store flushes the file and the rename.
                await this.store.write(this.email, this.provider.serializeTokens(this.tokenBag));
                logger.verbose(`Session tokens for ${this.email} saved to ${path.basename(filePath)}`);
            }
        } catch (error) {
            logger.error(`Failed to save session file for ${this.email} at ${filePath}`, { error });
            throw error;
        }
    }
}
