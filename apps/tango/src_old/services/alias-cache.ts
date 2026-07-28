export interface IAliasCache {
    getAlias(streamerId: string): string | undefined;
    setAlias(streamerId: string, alias: string): void;
    getName(streamerId: string): string | undefined;
    setName(streamerId: string, name: string): void;
    clear(): void;
}

const CACHE_KEY = "tango_alias_cache";

export function createAliasCache(): IAliasCache {
    let aliases: Record<string, string> = {};
    let names: Record<string, string> = {};

    const stored = localStorage.getItem(CACHE_KEY);
    if (stored) {
        const parsed = JSON.parse(stored);
        aliases = parsed.aliases || {};
        names = parsed.names || {};
    }

    function save() {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ aliases, names }));
    }

    return {
        getAlias: (streamerId: string) => aliases[streamerId],
        setAlias: (streamerId: string, alias: string) => { aliases[streamerId] = alias; save(); },
        getName: (streamerId: string) => names[streamerId],
        setName: (streamerId: string, name: string) => { names[streamerId] = name; save(); },
        clear: () => {
            aliases = {};
            names = {};
            localStorage.removeItem(CACHE_KEY);
        },
    };
}
