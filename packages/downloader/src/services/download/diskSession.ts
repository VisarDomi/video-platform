import { stat } from "fs/promises";
import * as path from "path";
import logger from "../../common/logger.js";
import { DownloadHandle } from "../state/downloadsManager.js";

export class DiskSession {
    private readonly alias: string;
    private readonly handle: DownloadHandle;
    private readonly setupDir: (claim: (dirPath: string) => void) => Promise<string | null>;
    private _dirPath: string | null = null;
    private _materialized = false;

    // `setupDir` creates the recording's folder and calls `claim` with its path before
    // creating it (see setupDownloadDir).
    constructor(
        alias: string,
        handle: DownloadHandle,
        setupDir: (claim: (dirPath: string) => void) => Promise<string | null>,
        existingDirPath?: string,
    ) {
        this.alias = alias;
        this.handle = handle;
        this.setupDir = setupDir;
        if (existingDirPath) {
            this._dirPath = existingDirPath;
            this._materialized = true;
            this.handle.update({ segmentsDirPath: existingDirPath });
            logger.info(`[DiskSession] ${this.alias}: recording resumed in ${path.basename(existingDirPath)}`);
        }
    }

    public get materialized(): boolean {
        return this._materialized;
    }

    public get dirPath(): string {
        if (!this._dirPath) {
            throw new Error(`[DiskSession] ${this.alias}: dirPath accessed before materialize()`);
        }
        return this._dirPath;
    }

    // False once the materialized folder is gone (moved or deleted under the session).
    public async present(): Promise<boolean> {
        if (!this._materialized || !this._dirPath) return true;
        return stat(this._dirPath).then((entry) => entry.isDirectory(), () => false);
    }

    public async materialize(): Promise<boolean> {
        if (this._materialized) return true;

        // Owned from before it exists, so the folder scan never takes it for an abandoned one.
        const dirPath = await this.setupDir((planned) => this.handle.update({ segmentsDirPath: planned }));
        if (!dirPath) {
            this.handle.update({ segmentsDirPath: null });
            logger.error(`[DiskSession] ${this.alias}: failed to create download dir`);
            return false;
        }

        this._dirPath = dirPath;
        this.handle.update({ segmentsDirPath: dirPath });
        this._materialized = true;
        logger.info(`[DiskSession] ${this.alias}: recording started in ${path.basename(dirPath)}`);
        return true;
    }
}
