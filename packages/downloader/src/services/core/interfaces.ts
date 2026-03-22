export interface SegmentFetchResult {
    data: Buffer | null;
    /** True if the failure was a timeout or transient network error.
     *  False (or absent) if the CDN returned an HTTP error (4xx/5xx).
     *  The download loop uses this to decide: retry vs stop. */
    retryable?: boolean;
}

export interface IDownloadSession {
    /** Fetch and decode the live playlist. Returns content or null.
     *  Null means stop — the caller doesn't need to know why.
     *  The reason is logged inside the implementation. */
    fetchPlaylist(url: string): Promise<string | null>;
    fetchSegment(url: string): Promise<SegmentFetchResult>;
}

export interface IStreamProvider {
    parseMasterPlaylist(masterUrl: string): Promise<string | null>;
    getSegmentUrl(baseUrl: string, segmentLine: string): string;
    setupDownloadDir(alias: string, date: Date): Promise<string | null>;
    validateSegment(filePath: string): Promise<{ valid: boolean; duration?: number }>;
    createDownloadSession(): IDownloadSession;

    /**
     * Attempt to find a working variant when the current one failed (404/403).
     * CDN-specific: SC tries all 3 TLDs in parallel and picks the best variant.
     * Providers without multi-edge CDNs return null.
     */
    recoverVariant(masterPlaylistUrl: string): Promise<string | null>;

    /**
     * After a download attempt exits, the provider decides whether to retry.
     * The provider owns this decision because "is the stream still live?"
     * means different things per platform:
     *   SC: cam API (isCamActive) is the source of truth
     *   Tango: the liveUrl itself is the source of truth (feed is stale)
     *   FC2: memberApi (is_publish) is the source of truth
     *
     * Returns a master URL to retry with, or null to stop.
     */
    shouldRetry(context: DownloadExitContext): Promise<string | null>;
}

export interface DownloadExitContext {
    streamerId: string;
    exitReason: "aborted" | "segment-failed" | "stale-timeout" | "fetch-failed";
    lastMasterUrl: string;
    lastLiveUrl: string | null;
}
