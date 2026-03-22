import * as path from "path";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";

export interface InitCommitResult {
    fileName: string;
    isQualityChange: boolean;
}

/**
 * Owns the relationship between MAP URIs and init segment files on disk.
 *
 * Invariant: currentMapUri is only updated AFTER the corresponding init
 * file is confirmed written to disk. If the download or write fails,
 * currentMapUri stays at its previous value, so the next loop iteration
 * will retry. There is no state where currentMapUri references a file
 * that doesn't exist.
 */
export class InitTracker {
    private currentMapUri: string | null = null;
    private segmentCount: number = 0;
    private readonly segmentsDirPath: string;

    constructor(segmentsDirPath: string) {
        this.segmentsDirPath = segmentsDirPath;
    }

    public needsUpdate(mapUri: string): boolean {
        return mapUri !== this.currentMapUri;
    }

    public incrementSegmentCount(): void {
        this.segmentCount++;
    }

    public get count(): number {
        return this.segmentCount;
    }

    /**
     * Atomically download, write, and commit a new init segment.
     *
     * Returns the committed result on success, null on failure.
     * On failure, currentMapUri is NOT updated — the caller should
     * retry on the next loop iteration.
     *
     * The fileName is derived from the current segmentCount at commit
     * time, tying the init file's identity to the download timeline.
     */
    public async commitInit(
        mapUri: string,
        downloadFn: () => Promise<Buffer | null>,
    ): Promise<InitCommitResult | null> {
        const buffer = await downloadFn();
        if (!buffer) return null;

        const isQualityChange = this.currentMapUri !== null;
        const fileName = isQualityChange
            ? `init_${this.segmentCount}.mp4`
            : "init.mp4";

        const filePath = path.join(this.segmentsDirPath, fileName);
        const ok = await FileSystemManager.writeFile(filePath, buffer as unknown as Uint8Array);
        if (!ok) {
            logger.warn(`[InitTracker] Write failed for ${fileName} — will retry`);
            return null;
        }

        // STATE TRANSITION: only after file is confirmed on disk.
        this.currentMapUri = mapUri;
        return { fileName, isQualityChange };
    }
}
