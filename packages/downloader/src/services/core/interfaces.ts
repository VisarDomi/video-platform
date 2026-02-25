export interface IStreamProvider {
    /**
     * Parse the initial master playlist (if applicable) to find the URL of the live variant.
     * @param masterUrl The URL provided by discovery
     */
    parseMasterPlaylist(masterUrl: string): Promise<string | null>;

    /**
     * Poll the provider to check if a better variant (quality) is available.
     * Returns the new URL if different, or null if no change/not supported.
     */
    pollCurrentVariant(masterUrl: string, currentLiveUrl: string): Promise<string | null>;

    /**
     * Download the content of a playlist.
     */
    getMasterList(url: string): Promise<string | null>;
    getLiveList(url: string): Promise<{ success: boolean; data: string | null }>;

    /**
     * Download a specific TS segment.
     */
    getTsSegment(url: string): Promise<Buffer | null>;

    /**
     * Combine a base URL (usually the live playlist URL) and a segment line
     * from the m3u8 to form a full download URL.
     */
    getSegmentUrl(baseUrl: string, segmentLine: string): string;

    /**
     * Create the folder structure for the download.
     */
    setupDownloadDir(alias: string, date: Date): Promise<string | null>;

    /**
     * Check if a downloaded segment is valid according to provider-specific rules.
     * @param filePath Path to the downloaded .ts file
     */
    validateSegment(filePath: string): Promise<boolean>;

    /**
     * Attempt to re-establish a connection for a streamer whose stream is still live
     * but whose transport (e.g. WebSocket) has died. Returns a new live URL on success.
     */
    reconnect?(streamerId: string): Promise<string | null>;
}