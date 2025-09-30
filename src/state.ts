// src/state.ts

// --- Download State ---
export interface ActiveDownload {
    streamerId: string;
    alias: string;
    liveUrl: string | null; // Is null until the master playlist is resolved
}
// The key is the master playlist URL from the /following API response
const _activeDownloads: Map<string, ActiveDownload> = new Map();


// --- Download Getters ---
// The Map is mutated directly, so we just need a getter.
export function getActiveDownloads(): Map<string, ActiveDownload> { return _activeDownloads; }