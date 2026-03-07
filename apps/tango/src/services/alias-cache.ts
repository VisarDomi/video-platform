export interface IAliasCache {
    getAlias(streamerId: string): string | undefined;
    setAlias(streamerId: string, alias: string): void;
    getName(streamerId: string): string | undefined;
    setName(streamerId: string, name: string): void;
    clear(): void;
}

const CACHE_KEY = "tango_alias_cache";

export function createAliasCache(setTimeoutFn: typeof window.setTimeout): IAliasCache {
    let aliases: Record<string, string> = {};
    let names: Record<string, string> = {};
    let isSaving = false;
    let isDirty = false;

    // Load from localStorage
    try {
        const stored = localStorage.getItem(CACHE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            aliases = parsed.aliases || {};
            names = parsed.names || {};
        }
    } catch (e) {
        console.error("AliasCache: Failed to load from localStorage", e);
    }

    async function processSaveQueue() {
        if (isSaving) return;
        isSaving = true;

        while (isDirty) {
            isDirty = false;
            try {
                await new Promise<void>((resolve) =>
                    setTimeoutFn(() => {
                        localStorage.setItem(CACHE_KEY, JSON.stringify({ aliases, names }));
                        resolve();
                    }, 0)
                );
            } catch (e) {
                console.error("AliasCache: Failed to save to localStorage", e);
                break;
            }
        }
        isSaving = false;
    }

    function update(target: Record<string, string>, key: string, value: string) {
        target[key] = value;
        isDirty = true;
        processSaveQueue();
    }

    return {
        getAlias: (streamerId: string) => aliases[streamerId],
        setAlias: (streamerId: string, alias: string) => update(aliases, streamerId, alias),
        getName: (streamerId: string) => names[streamerId],
        setName: (streamerId: string, name: string) => update(names, streamerId, name),
        clear: () => {
            aliases = {};
            names = {};
            isDirty = false;
            localStorage.removeItem(CACHE_KEY);
        },
    };
}
