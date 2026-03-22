export interface SegmentFetchResult {
    data: Buffer | null;
    retryable?: boolean;
}

export interface IDownloadSession {
    fetchPlaylist(url: string): Promise<string | null>;
    fetchSegment(url: string): Promise<SegmentFetchResult>;
}

export interface IStreamProvider {
    parseMasterPlaylist(masterUrl: string): Promise<string | null>;
    getSegmentUrl(baseUrl: string, segmentLine: string): string;
    setupDownloadDir(alias: string, date: Date): Promise<string | null>;
    validateSegment(filePath: string): Promise<{ valid: boolean; duration?: number }>;
    createDownloadSession(): IDownloadSession;

    recoverVariant(masterPlaylistUrl: string): Promise<string | null>;

    shouldRetry(context: DownloadExitContext): Promise<string | null>;
}

export interface DownloadExitContext {
    streamerId: string;
    exitReason: "aborted" | "segment-failed" | "stale-timeout" | "fetch-failed";
    lastMasterUrl: string;
    lastLiveUrl: string | null;
}
