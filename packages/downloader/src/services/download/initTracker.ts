import * as path from "path";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { DiskSession } from "./diskSession.js";

export interface InitCommitResult {
    fileName: string;
    isQualityChange: boolean;
}

export class InitWriteError extends Error {
    constructor(readonly filePath: string) {
        super(`init segment could not be written: ${filePath}`);
    }
}

export class InitTracker {
    private currentMapUri: string | null = null;
    private currentInitBytes: Buffer | null = null;
    private currentFileName: string | null = null;
    private pendingInit: { mapUri: string; data: Buffer } | null = null;
    private segmentCount: number = 0;
    private readonly disk: DiskSession;
    private resumeBoundary = false;
    private resumeLocalNumber = 0;

    constructor(disk: DiskSession) {
        this.disk = disk;
    }

    public needsUpdate(mapUri: string): boolean {
        return mapUri !== this.currentMapUri && mapUri !== this.pendingInit?.mapUri;
    }

    public incrementSegmentCount(): void {
        this.segmentCount++;
    }

    public get count(): number {
        return this.segmentCount;
    }

    public markResumeBoundary(nextLocalNumber: number, existingInitBytes: Buffer | null = null, existingFileName: string | null = null): void {
        this.resumeBoundary = true;
        this.resumeLocalNumber = nextLocalNumber;
        this.currentMapUri = null;
        this.pendingInit = null;
        this.currentInitBytes = existingInitBytes;
        this.currentFileName = existingFileName;
    }

    // Downloads a new map into memory without touching disk yet. Identical bytes
    // under a new URL (e.g. CDN edge or token rotation) reuse the active init file.
    public async stageInit(
        mapUri: string,
        downloadFn: () => Promise<import("../core/interfaces.js").SegmentFetchResult>,
    ): Promise<"unchanged" | "staged" | null> {
        const result = await downloadFn();
        if (!result.data) return null;
        const buffer = result.data;

        if (this.currentInitBytes && this.currentInitBytes.equals(buffer)) {
            this.currentMapUri = mapUri;
            this.pendingInit = null;
            this.resumeBoundary = false;
            return "unchanged";
        }

        this.pendingInit = { mapUri, data: buffer };
        return "staged";
    }

    // Commits a staged init map to disk right before the first segment that uses it,
    // so a failing segment never leaves an unreferenced init file behind.
    public async flushPendingInit(nextLocalNumber: number): Promise<InitCommitResult | null> {
        const pending = this.pendingInit;
        if (!pending) return null;

        if (!await this.disk.materialize()) return null;

        const isQualityChange = this.resumeBoundary || this.currentMapUri !== null || this.currentInitBytes !== null;
        const baseNumber = this.resumeBoundary ? this.resumeLocalNumber : nextLocalNumber;
        let fileName = isQualityChange ? `init_${baseNumber}.mp4` : "init.mp4";
        let written: "written" | "exists" | "failed" = "exists";
        // Only a taken name moves on to the next one; any other failure (the folder
        // is gone, the disk is full) is final for this recording.
        for (let suffix = 0; suffix < 100 && written === "exists"; suffix++) {
            if (suffix > 0) fileName = `init_${baseNumber}_${suffix}.mp4`;
            const filePath = path.join(this.disk.dirPath, fileName);
            written = await FileSystemManager.writeFileExclusive(filePath, pending.data as unknown as Uint8Array);
        }
        if (written === "failed") throw new InitWriteError(path.join(this.disk.dirPath, fileName));
        if (written === "exists") {
            logger.warn(`[InitTracker] Could not allocate a non-overwriting init filename near ${fileName}`);
            return null;
        }

        this.currentMapUri = pending.mapUri;
        this.currentInitBytes = pending.data;
        this.currentFileName = fileName;
        this.pendingInit = null;
        this.resumeBoundary = false;
        return { fileName, isQualityChange };
    }

    public async commitInit(
        mapUri: string,
        downloadFn: () => Promise<import("../core/interfaces.js").SegmentFetchResult>,
        nextLocalNumber: number,
    ): Promise<InitCommitResult | null> {
        const staged = await this.stageInit(mapUri, downloadFn);
        if (staged === null) return null;
        if (staged === "unchanged") {
            return { fileName: this.currentFileName ?? "init.mp4", isQualityChange: false };
        }
        return await this.flushPendingInit(nextLocalNumber);
    }
}
