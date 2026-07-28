import type { Stream } from "../provider";

const KEY = "stream-viewer-state";

export interface SharedState {
    streams: Stream[];
    currentStreamerId: string;
    selectedTop: number;
}

export function loadState(): SharedState | null {
    try {
        const value = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as SharedState | null;
        return value && Array.isArray(value.streams) ? value : null;
    } catch {
        return null;
    }
}

export function saveState(state: SharedState): void {
    sessionStorage.setItem(KEY, JSON.stringify(state));
}
