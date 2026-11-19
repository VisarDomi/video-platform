// Live capture contract. These are the shapes the downloader's core already drives;
// a site plug-in implements them and the core owns everything around them: the
// discovery loop's lifecycle, sessions, sequence and gap accounting, access incidents,
// copy failover, durability and finalization.

export interface SegmentDimensions {
    width: number;
    height: number;
    sampleAspectRatio: string;
}

export interface SegmentValidationResult {
    valid: boolean;
    duration?: number;
    // null means an attempted TS dimension probe failed; undefined means the
    // site uses other boundary metadata (fMP4 init maps).
    dimensions?: SegmentDimensions | null;
}

export interface SegmentFetchResult {
    data: Buffer | null;
    retryable?: boolean;
    status?: number;
    error?: string;
    // What the session repaired in the received bytes, for the log.
    repair?: string;
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
    // An aborted request returns null and records no failure.
    fetchPlaylist(url: string, signal?: AbortSignal): Promise<string | null>;
    fetchSegment(url: string, signal?: AbortSignal): Promise<SegmentFetchResult>;
    getLastPlaylistFailure?(): PlaylistFetchFailure | null;
}

export interface DownloadExitContext {
    streamerId: string;
    recordingId: string;
    lookupAlias?: string;
    exitReason: "aborted" | "remote-endlist" | "playlist-not-found" | "segment-failed" | "stale-timeout" | "fetch-failed";
    lastMasterUrl: string;
    lastLiveUrl: string | null;
}

export interface IStreamProvider {
    readonly providerName: string;
    // False keeps the selected live URL for the recording, including retries.
    readonly refreshMasterDuringDownload?: boolean;
    // Wait before polling again after the live playlist could not be fetched.
    // It must stay well inside the live window.
    readonly playlistRetryMs?: number;
    parseMasterPlaylist(masterUrl: string): Promise<string | null>;
    validateSegment(filePath: string): Promise<SegmentValidationResult>;
    createDownloadSession(): IDownloadSession;

    // Copy failover: another copy of the same live variant when the current one fails
    // (null when the site has no alternative). The core switches to it and stitches the
    // copies together by program date-time.
    recoverVariant(masterPlaylistUrl: string): Promise<string | null>;
    // Which copy (CDN edge) a variant URL belongs to. Absent or null means the site
    // serves a single copy, and edge stitching never activates.
    edgeOf?(variantUrl: string): string | null;
    // URL equivalence for the quality-upgrade check: two variant URLs with the same
    // key are the same rendition. Defaults to the URL without its query string.
    variantKey?(variantUrl: string): string;

    shouldRetry(context: DownloadExitContext): Promise<string | null>;

    describeVariant?(url: string): StreamVariantDescription | null;
    diagnoseAccessFailure?(context: AccessFailureContext): Promise<Record<string, unknown>>;
}

export interface ProviderLiveStream {
    targetId: string;
    alias: string;
    recordingId: string;
    masterPlaylistUrl: string;
}

// One lookup of the site: who is live now, and which listed targets the site confirms
// as offline or non-public (terminal). A failed lookup is null, never "all offline".
export interface ProviderSnapshot {
    observedAt: number;
    live: Map<string, ProviderLiveStream>;
    terminalTargetIds: Set<string>;
}
