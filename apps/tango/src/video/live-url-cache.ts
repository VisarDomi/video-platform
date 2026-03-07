export interface ILiveUrlCache {
    get(streamerId: string): string | undefined;
    set(streamerId: string, url: string): void;
    clear(): void;
}

const CACHE_KEY = "tango_liveurl_cache";

export function createLiveUrlCache(setTimeoutFn: typeof window.setTimeout): ILiveUrlCache {
    let cache: Record<string, string> = {};
    let isSaving = false;
    let isDirty = false;

    // Load from localStorage
    try {
        const stored = localStorage.getItem(CACHE_KEY);
        if (stored) {
            cache = JSON.parse(stored);
        }
    } catch (e) {
        console.error("LiveUrlCache: Failed to load from localStorage", e);
    }

    async function processSaveQueue() {
        if (isSaving) return;
        isSaving = true;

        while (isDirty) {
            isDirty = false;
            try {
                await new Promise<void>((resolve) =>
                    setTimeoutFn(() => {
                        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
                        resolve();
                    }, 0)
                );
            } catch (e) {
                console.error("LiveUrlCache: Failed to save to localStorage", e);
                break;
            }
        }
        isSaving = false;
    }

    return {
        get: (streamerId: string) => cache[streamerId],
        set: (streamerId: string, url: string) => {
            cache[streamerId] = url;
            isDirty = true;
            processSaveQueue();
        },
        clear: () => {
            cache = {};
            isDirty = false;
            localStorage.removeItem(CACHE_KEY);
        },
    };
}
