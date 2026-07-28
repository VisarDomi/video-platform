export interface ILiveUrlCache {
    get(streamerId: string): string | undefined;
    set(streamerId: string, url: string): void;
    clear(): void;
}

const CACHE_KEY = "tango_liveurl_cache";

export function createLiveUrlCache(): ILiveUrlCache {
    let cache: Record<string, string> = {};

    const stored = localStorage.getItem(CACHE_KEY);
    if (stored) {
        cache = JSON.parse(stored);
    }

    return {
        get: (streamerId: string) => cache[streamerId],
        set: (streamerId: string, url: string) => { cache[streamerId] = url; localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); },
        clear: () => {
            cache = {};
            localStorage.removeItem(CACHE_KEY);
        },
    };
}
