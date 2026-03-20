export interface IDownloadSession {
    getLiveList(url: string): Promise<{ success: boolean; data: string | null }>;
    getTsSegment(url: string): Promise<Buffer | null>;
}

export interface IStreamProvider {
    parseMasterPlaylist(masterUrl: string): Promise<string | null>;
    pollCurrentVariant(masterUrl: string, currentLiveUrl: string): Promise<string | null>;
    getMasterList(url: string): Promise<string | null>;
    getSegmentUrl(baseUrl: string, segmentLine: string): string;
    setupDownloadDir(alias: string, date: Date): Promise<string | null>;
    validateSegment(filePath: string): Promise<{ valid: boolean; duration?: number }>;
    createDownloadSession(): IDownloadSession;
}
