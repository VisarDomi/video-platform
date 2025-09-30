// src/auth/authContext.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '../logger.js';
import * as config from '../config.js';
import { HEADERS, COOKIE_NAMES } from './authConstants.js';

/**
 * A container for all authentication-related state and header generation logic.
 */
export class AuthContext {
    private tangoRT: string | null = null;
    private tangoST: string | null = null;
    private tt: string | null = null;
    private ttu: string | null = null;
    private tte: string | null = null;

    public getTangoRT(): string | null { return this.tangoRT; }
    public setTangoRT(rt: string): void { this.tangoRT = rt; }
    public getTangoST(): string | null { return this.tangoST; }
    public setTangoST(st: string): void { this.tangoST = st; }
    public getTt(): string | null { return this.tt; }
    public setTt(tt: string): void { this.tt = tt; }
    public getTtu(): string | null { return this.ttu; }
    public setTtu(ttu: string): void { this.ttu = ttu; }
    public getTte(): string | null { return this.tte; }
    public setTte(tte: string): void { this.tte = tte; }

    /**
     * Generates the headers required for general API calls.
     * @throws Will throw if the Tango-ST token is missing.
     */
    public getApiHeaders(): HeadersInit {
        if (!this.tangoST) {
            throw new Error("Cannot create API headers: Tango-ST is missing from AuthContext.");
        }
        return { [HEADERS.COOKIE]: `${COOKIE_NAMES.TANGO_ST_PREFIX}${this.tangoST}` };
    }

    /**
     * Generates the headers required for stream playlist access.
     * @throws Will throw if tt, ttu, or tte tokens are missing.
     */
    public getStreamHeaders(): HeadersInit {
        if (!this.tt || !this.ttu || !this.tte) {
            throw new Error("Cannot create stream headers: tt, ttu, or tte are missing from AuthContext.");
        }
        const cookie = `tt=${this.tt};ttu=${this.ttu};tte=${this.tte}`;
        return { [HEADERS.COOKIE]: cookie };
    }

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