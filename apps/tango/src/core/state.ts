import type { Stream } from "../provider";

const KEY = "stream-viewer-state";

export function isPageReload(): boolean {
    return performance.getEntriesByType("navigation")
        .some(entry => (entry as PerformanceNavigationTiming).type === "reload");
}

export interface SharedState {
    streams: Stream[];
    currentStreamerId: string;
}

function isStream(value: unknown): value is Stream {
    if (typeof value !== "object" || value === null) return false;
    const stream = value as Partial<Stream>;
    return typeof stream.streamerId === "string"
        && typeof stream.streamId === "string"
        && typeof stream.masterListUrl === "string"
        && typeof stream.firstName === "string"
        && typeof stream.isFollowing === "boolean"
        && (stream.alias === undefined || typeof stream.alias === "string")
        && (stream.parentStreamerId === undefined || typeof stream.parentStreamerId === "string");
}

export function loadState(): SharedState | null {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;

    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) throw new Error("Stored stream state is not an object");
    const state = value as Partial<SharedState>;
    if (!Array.isArray(state.streams)
        || !state.streams.every(isStream)
        || typeof state.currentStreamerId !== "string") {
        throw new Error("Stored stream state is invalid");
    }
    return state as SharedState;
}

export function saveState(state: SharedState): void {
    sessionStorage.setItem(KEY, JSON.stringify(state));
}
