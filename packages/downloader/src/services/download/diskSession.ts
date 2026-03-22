import * as path from "path";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";

/**
 * Owns the download directory on disk. Nothing is created until
 * materialize() is called — which happens at first byte write.
 *
 * All disk writers (InitTracker, PlaylistManager, segment writes)
 * go through this object. The dir and playlist header are created
 * together, atomically, the first time any writer needs disk.
 */
export class DiskSession {
    private readonly alias: string;
    private readonly setupDir: () => Promise<string | null>;
    private _dirPath: string | null = null;
    private _materialized = false;

    constructor(alias: string, setupDir: () => Promise<string | null>) {
        this.alias = alias;
        this.setupDir = setupDir;
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

    /**
     * Create the download dir on disk. Called once, right before
     * the first byte needs to be written. Returns false if the dir
     * could not be created.
     */
    public async materialize(): Promise<boolean> {
        if (this._materialized) return true;

        const dirPath = await this.setupDir();
        if (!dirPath) {
            logger.error(`[DiskSession] ${this.alias}: failed to create download dir`);
            return false;
        }

        this._dirPath = dirPath;
        this._materialized = true;
        logger.info(`[DiskSession] ${this.alias}: dir materialized at ${path.basename(dirPath)}`);
        return true;
    }
}
