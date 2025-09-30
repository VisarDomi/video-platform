// src/authContext.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import logger from './logger.js';
import * as config from './config.js';

const getSessionFilePath = () => path.resolve(process.cwd(), config.getConfig().fileNames.session);

/**
 * A container for all authentication-related state and formatting logic.
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

    // --- NEW: Moved from utils.ts ---
    public createCookie(): string {
        if (!(this.tt && this.ttu && this.tte)) {
            throw new Error("tt, ttu, tte not found in AuthContext");
        }
        return `tt=${this.tt};ttu=${this.ttu};tte=${this.tte}`;
    }

    public createCookieST(): string {
        if (!this.tangoST) {
            throw new Error("Tango-ST not found in AuthContext");
        }
        return `Tango-ST=${this.tangoST}`;
    }
    // --- END NEW ---

    public async loadTokenFromFile(): Promise<boolean> {
        try {
            const filePath = getSessionFilePath();
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
                const filePath = getSessionFilePath();
                await fs.writeFile(filePath, JSON.stringify({ tangoRT: this.tangoRT }, null, 2));
                logger.info(`Session token (Tango-RT) saved to ${config.getConfig().fileNames.session}`);
            }
        } catch (error) {
            logger.error('Failed to save session file', { error });
        }
    }
}