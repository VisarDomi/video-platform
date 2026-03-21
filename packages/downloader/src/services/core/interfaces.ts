export interface IDownloadSession {
    /** Fetch and decode the live playlist. Returns content or null.
     *  Null means stop — the caller doesn't need to know why.
     *  The reason is logged inside the implementation. */
    fetchPlaylist(url: string): Promise<string | null>;
    fetchSegment(url: string): Promise<Buffer | null>;
}

export interface IStreamProvider {
    parseMasterPlaylist(masterUrl: string): Promise<string | null>;
    getSegmentUrl(baseUrl: string, segmentLine: string): string;
    setupDownloadDir(alias: string, date: Date): Promise<string | null>;
    validateSegment(filePath: string): Promise<{ valid: boolean; duration?: number }>;
    createDownloadSession(): IDownloadSession;
}
