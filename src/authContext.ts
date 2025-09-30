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
    // We will add tt, ttu, tte, tangoST here in later steps.

    public getTangoRT(): string | null {
        return this.tangoRT;
    }

    public setTangoRT(rt: string): void {
        this.tangoRT = rt;
    }

    /**
     * Attempts to load the Tango-RT from the session file into this context.
     * @returns {Promise<boolean>} True if the token was successfully loaded, false otherwise.
     */
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
            if (error.code !== 'ENOENT') { // Don't log an error if the file simply doesn't exist
                logger.error('Failed to read session file', { error });
            }
        }
        return false;
    }

    /**
     * Saves the current Tango-RT from this context to the session file.
     */
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