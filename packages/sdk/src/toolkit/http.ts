// A request's own timeout, shared by the core and the sites for playlists, segments and
// site APIs. It bounds how long one stalled request can hold up a capture.
export const CDN_FETCH_TIMEOUT_MS = 30_000;

// AbortSignal.any exists at runtime (Node 20.3+); older type definitions lack it.
const AnyAbortSignal = AbortSignal as typeof AbortSignal & { any(signals: AbortSignal[]): AbortSignal };

// A request's own timeout, plus the caller's signal when it has one. Sessions pass the
// core's signal through, so a stopped capture cancels its requests at once.
export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AnyAbortSignal.any([signal, timeout]) : timeout;
}

// A playlist line (segment, variant or map URI) resolved against the playlist's URL.
// A line that is not a URL is returned unchanged.
export function resolveSegmentUrl(baseUrl: string, segmentLine: string): string {
    try {
        return new URL(segmentLine, baseUrl).href;
    } catch {
        return segmentLine;
    }
}
