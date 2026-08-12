import * as path from "path";
import logger from "../../common/logger.js";
import { DownloadHandle } from "../state/downloadsManager.js";

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
        existingDirPath?: string,
    ) {
        this.alias = alias;
        this.handle = handle;
        this.setupDir = setupDir;
        if (existingDirPath) {
            this._dirPath = existingDirPath;
            this._materialized = true;
            this.handle.update({ segmentsDirPath: existingDirPath });
            logger.info(`[DiskSession] ${this.alias}: resumed at ${path.basename(existingDirPath)}`);
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
