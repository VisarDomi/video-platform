// src/auth/authContext.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '../logger.js';
import * as config from '../config.js';
import { HEADERS, COOKIE_NAMES } from './authConstants.js';
import { RefreshResult, TokenDataResult } from './authClient.js';

interface LoginResult {
    tangoRT: string;
    tangoST: string;
}

/**
 * A container for all authentication-related state, state transitions, and header generation.
 */
export class AuthContext {
    private tangoRT: string | null = null;
    private tangoST: string | null = null;
    private tt: string | null = null;
    private ttu: string | null = null;
    private tte: string | null = null;

    // --- State Getters ---
    public getTangoRT(): string | null { return this.tangoRT; }
    public getTangoST(): string | null { return this.tangoST; }
    // --- RE-ADDED GETTERS ---
    public getTt(): string | null { return this.tt; }
    public getTtu(): string | null { return this.ttu; }
    public getTte(): string | null { return this.tte; }
    // --- END RE-ADDED GETTERS ---

    // --- State Update Methods ---
    /**
     * Updates the context's state from a successful session refresh response.
     * @returns `true` if a new Tango-RT was received, otherwise `false`.
     */
    public updateFromRefresh(result: RefreshResult): boolean {
        this.tangoST = result.newTangoST;
        if (result.newTangoRT) {
            this.tangoRT = result.newTangoRT;
            return true;
        }
        return false;
    }

    /**
     * Updates the context's state from a successful token data response.
     */
    public updateFromTokenData(result: TokenDataResult): void {
        this.tt = result.tt;
        this.ttu = result.ttu;
        this.tte = result.tte;
    }

    /**
     * Updates the context's state from a successful Puppeteer login.
     */
    public updateFromLogin(result: LoginResult): void {
        this.tangoRT = result.tangoRT;
        this.tangoST = result.tangoST;
    }

    // --- Header Generation ---
    public getApiHeaders(): HeadersInit {
        if (!this.tangoST) {
            throw new Error("Cannot create API headers: Tango-ST is missing from AuthContext.");
        }
        return { [HEADERS.COOKIE]: `${COOKIE_NAMES.TANGO_ST_PREFIX}${this.tangoST}` };
    }

    public getStreamHeaders(): HeadersInit {
        if (!this.tt || !this.ttu || !this.tte) {
            throw new Error("Cannot create stream headers: tt, ttu, or tte are missing from AuthContext.");
        }
        const cookie = `tt=${this.tt};ttu=${this.ttu};tte=${this.tte}`;
        return { [HEADERS.COOKIE]: cookie };
    }

    // --- File Operations ---
    public async loadTokenFromFile(): Promise<boolean> {
        try {
            const filePath = path.resolve(process.cwd(), config.getConfig().fileNames.session);
            const data = await fs.readFile(filePath, 'utf-8');
            const session = JSON.parse(data);
            if (session.tangoRT) {
                this.tangoRT = session.tangoRT;
                return true;
            }
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                logger.error('Failed to read session file', { error });
            }
        }
        return false;
    }

    public async saveTokenToFile(): Promise<void> {
        try {
            if (this.tangoRT) {
                const filePath = path.resolve(process.cwd(), config.getConfig().fileNames.session);
                await fs.writeFile(filePath, JSON.stringify({ tangoRT: this.tangoRT }, null, 2));
                logger.info(`Session token (Tango-RT) saved to ${config.getConfig().fileNames.session}`);
            }
        } catch (error) {
            logger.error('Failed to save session file', { error });
        }
    }
}