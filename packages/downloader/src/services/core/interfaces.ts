export interface SegmentFetchResult {
    data: Buffer | null;
    retryable?: boolean;
    status?: number;
    error?: string;
}

export interface PlaylistFetchFailure {
    kind: "http" | "network" | "decrypt";
    status?: number;
    error?: string;
}

export interface StreamVariantDescription {
    name: string;
    resolution: string;
    bandwidth: number;
    isMasterBest: boolean;
}

export interface AccessFailureContext {
    stage: "playlist" | "segment";
    streamerId: string;
    alias: string;
    recordingId: string;
    masterUrl: string;
    liveUrl: string;
    failure: PlaylistFetchFailure;
}

export interface IDownloadSession {
    fetchPlaylist(url: string): Promise<string | null>;
    fetchSegment(url: string): Promise<SegmentFetchResult>;
    getLastPlaylistFailure?(): PlaylistFetchFailure | null;
}

export interface IStreamProvider {
    readonly providerName: string;
    parseMasterPlaylist(masterUrl: string): Promise<string | null>;
    validateSegment(filePath: string): Promise<{ valid: boolean; duration?: number }>;
    createDownloadSession(): IDownloadSession;

    recoverVariant(masterPlaylistUrl: string): Promise<string | null>;

    shouldRetry(context: DownloadExitContext): Promise<string | null>;

    describeVariant?(url: string): StreamVariantDescription | null;
    diagnoseAccessFailure?(context: AccessFailureContext): Promise<Record<string, unknown>>;
}

export interface DownloadExitContext {
    streamerId: string;
    recordingId: string;
    lookupAlias?: string;
    exitReason: "aborted" | "remote-endlist" | "segment-failed" | "stale-timeout" | "fetch-failed";
    lastMasterUrl: string;
    lastLiveUrl: string | null;
}
