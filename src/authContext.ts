// src/authContext.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import logger from './logger.js';
import * as config from './config.js';

const getSessionFilePath = () => path.resolve(process.cwd(), config.getConfig().fileNames.session);

/**
 * A container for all authentication-related state.
 * This class centralizes token management, moving away from global state.
 */
export class AuthContext {
    private tangoRT: string | null = null;
    private tangoST: string | null = null; // <-- NEW

    public getTangoRT(): string | null {
        return this.tangoRT;
    }

    public setTangoRT(rt: string): void {
        this.tangoRT = rt;
    }

    // --- NEW GETTER/SETTER ---
    public getTangoST(): string | null {
        return this.tangoST;
    }

    public setTangoST(st: string): void {
        this.tangoST = st;
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