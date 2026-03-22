import * as path from "path";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import logger from "../../common/logger.js";
import { DiskSession } from "./diskSession.js";

export interface InitCommitResult {
    fileName: string;
    isQualityChange: boolean;
}

export class InitTracker {
    private currentMapUri: string | null = null;
    private segmentCount: number = 0;
    private readonly disk: DiskSession;

    constructor(disk: DiskSession) {
        this.disk = disk;
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

    public async commitInit(
        mapUri: string,
        downloadFn: () => Promise<import("../core/interfaces.js").SegmentFetchResult>,
    ): Promise<InitCommitResult | null> {
        const result = await downloadFn();
        if (!result.data) return null;
        const buffer = result.data;

        if (!await this.disk.materialize()) return null;

        const isQualityChange = this.currentMapUri !== null;
        const fileName = isQualityChange
            ? `init_${this.segmentCount}.mp4`
            : "init.mp4";

        const filePath = path.join(this.disk.dirPath, fileName);
        const ok = await FileSystemManager.writeFile(filePath, buffer as unknown as Uint8Array);
        if (!ok) {
            logger.warn(`[InitTracker] Write failed for ${fileName} — will retry`);
            return null;
        }

        this.currentMapUri = mapUri;
        return { fileName, isQualityChange };
    }
}
