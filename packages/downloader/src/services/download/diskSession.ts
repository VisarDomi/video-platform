import * as path from "path";
import logger from "../../common/logger.js";
import { DownloadHandle } from "../state/downloadsManager.js";

/**
 * Owns the download directory on disk and its visibility in live-status.json.
 *
 * Nothing is created until materialize() is called — which happens at
 * first byte write. When the dir is created, the handle is updated
 * atomically — the system cannot observe a dir that exists without
 * the handle knowing about it, and vice versa.
 *
 * All disk writers (InitTracker, PlaylistManager, segment writes)
 * go through this object.
 */
export class DiskSession {
    private readonly alias: string;
    private readonly handle: DownloadHandle;
    private readonly setupDir: () => Promise<string | null>;
    private _dirPath: string | null = null;
    private _materialized = false;

    constructor(
        alias: string,
        handle: DownloadHandle,
        setupDir: () => Promise<string | null>,
    ) {
        this.alias = alias;
        this.handle = handle;
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
     * Create the download dir on disk and update the handle atomically.
     * After this call, the dir exists AND live-status.json reflects it.
     * Called once, right before the first byte needs to be written.
     */
    public async materialize(): Promise<boolean> {
        if (this._materialized) return true;

        const dirPath = await this.setupDir();
        if (!dirPath) {
            logger.error(`[DiskSession] ${this.alias}: failed to create download dir`);
            return false;
        }

        this._dirPath = dirPath;
        this.handle.update({ segmentsDirPath: dirPath });
        this._materialized = true;
        logger.info(`[DiskSession] ${this.alias}: dir materialized at ${path.basename(dirPath)}`);
        return true;
    }
}
