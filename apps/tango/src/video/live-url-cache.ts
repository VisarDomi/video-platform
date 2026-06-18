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

    const stored = localStorage.getItem(CACHE_KEY);
    if (stored) {
        cache = JSON.parse(stored);
    }

    async function processSaveQueue() {
        if (isSaving) return;
        isSaving = true;

        while (isDirty) {
            isDirty = false;
            await new Promise<void>((resolve) =>
                setTimeoutFn(() => {
                    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
                    resolve();
                }, 0)
            );
        }
        isSaving = false;
    }

    return {
        get: (streamerId: string) => cache[streamerId],
        set: (streamerId: string, url: string) => {
            cache[streamerId] = url;
            isDirty = true;
            void processSaveQueue();
        },
        clear: () => {
            cache = {};
            isDirty = false;
            localStorage.removeItem(CACHE_KEY);
        },
    };
}
