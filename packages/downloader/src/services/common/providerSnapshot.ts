export interface ProviderLiveStream {
    targetId: string;
    alias: string;
    recordingId: string;
    masterPlaylistUrl: string;
}

export interface ProviderSnapshot {
    observedAt: number;
    live: Map<string, ProviderLiveStream>;
    terminalTargetIds: Set<string>;
}
