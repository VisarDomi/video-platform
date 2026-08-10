import { promises as fs } from "fs";
import * as path from "path";
import { createLogger } from "shared";
import { acquireLock } from "./fileLock.js";

const logger = createLogger("AliasRegistry");

const TANGO_URL_PREFIX = "https://tango.me/";

interface AliasEntry {
    current: string;
    history: string[];
    lastVerifiedAt: number;
}

export interface AliasSnapshot {
    current: string;
    history: string[];
}

export type AliasFetcher = (streamerIds: string[]) => Promise<Record<string, AliasSnapshot>>;

export class AliasRegistry {
    private readonly filePath: string;
    private readonly lockPath: string;
    private state: Map<string, AliasEntry> = new Map();

    constructor(aliasesFilePath: string) {
        this.filePath = aliasesFilePath;
        this.lockPath = aliasesFilePath + ".lock";
    }

    async load(): Promise<void> {
        const raw = await this.readDisk();
        this.state = raw;
        logger.info(`Loaded ${this.state.size} aliases from disk`);
    }

    resolve(streamerId: string): string | undefined {
        return this.state.get(streamerId)?.current;
    }

    resolveAll(): Record<string, string> {
        const result: Record<string, string> = {};
        for (const [id, entry] of this.state) {
            result[id] = entry.current;
        }
        return result;
    }

    getAllWithHistory(): Record<string, string[]> {
        const result: Record<string, string[]> = {};
        for (const [id, entry] of this.state) {
            result[id] = [...entry.history, entry.current];
        }
        return result;
    }

    getReverse(): Record<string, string> {
        const reverse: Record<string, string> = {};
        for (const [id, entry] of this.state) {
            reverse[entry.current] = id;
            for (const alias of entry.history) {
                reverse[alias] = id;
            }
        }
        return reverse;
    }

    async refresh(fetcher: AliasFetcher, streamerIds: string[]): Promise<void> {
        if (streamerIds.length === 0) return;

        const aliasMap = await fetcher(streamerIds);
        let updated = 0;

        for (const [streamerId, aliases] of Object.entries(aliasMap)) {
            const changed = this.recordAliases(streamerId, aliases);
            if (changed) updated++;
        }

        await this.persistToDisk();
        logger.info(`Refresh complete: ${Object.keys(aliasMap).length}/${streamerIds.length} resolved, ${updated} updated`);
    }

    async mergeAliasSnapshot(streamerId: string, aliases: AliasSnapshot): Promise<boolean> {
        const changed = this.recordAliases(streamerId, aliases);
        await this.persistToDisk();
        return changed;
    }

    startPeriodicRefresh(
        intervalMs: number,
        getStreamerIds: () => Promise<string[]>,
        fetcher: AliasFetcher,
        tangoTxtPath?: string,
    ): () => void {
        const performRefresh = async () => {
            try {
                const ids = await getStreamerIds();
                await this.refresh(fetcher, ids);
                if (tangoTxtPath) {
                    await this.syncTangoTxt(tangoTxtPath);
                }
            } catch (err: any) {
                logger.error(`Periodic refresh failed: ${err.message}`);
            }
        };

        void performRefresh();
        const timer = setInterval(performRefresh, intervalMs);
        return () => clearInterval(timer);
    }

    async syncTangoTxt(filePath: string): Promise<void> {
        let content: string;
        try {
            content = await fs.readFile(filePath, "utf-8");
        } catch {
            return;
        }

        const lines = content.split("\n");
        let changed = false;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(TANGO_URL_PREFIX)) continue;

            const rest = trimmed.slice(TANGO_URL_PREFIX.length);
            const spaceIdx = rest.indexOf(" ");
            if (spaceIdx === -1) continue;

            const accountId = rest.slice(0, spaceIdx);
            const oldAlias = rest.slice(spaceIdx + 1);
            const currentAlias = this.resolve(accountId);

            if (currentAlias && currentAlias !== oldAlias) {
                lines[i] = `${TANGO_URL_PREFIX}${accountId} ${currentAlias}`;
                logger.info(`tango.txt sync: ${accountId} ${oldAlias} -> ${currentAlias}`);
                changed = true;
            }
        }

        if (changed) {
            await fs.writeFile(filePath, lines.join("\n"), "utf-8");
        }
    }

    private recordAliases(streamerId: string, aliases: AliasSnapshot): boolean {
        const existing = this.state.get(streamerId);
        const now = Date.now();
        const current = aliases.current.trim();
        if (!current) return false;

        const history = uniqueAliases([
            ...(existing?.history ?? []),
            ...(existing ? [existing.current] : []),
            ...aliases.history,
        ]).filter(alias => alias !== current);

        const changed = !existing
            || existing.current !== current
            || !sameAliases(existing.history, history);

        this.state.set(streamerId, { current, history, lastVerifiedAt: now });
        return changed;
    }

    private async readDisk(): Promise<Map<string, AliasEntry>> {
        try {
            const raw = await fs.readFile(this.filePath, "utf-8");
            const json: Record<string, string | string[]> = JSON.parse(raw);
            const result = new Map<string, AliasEntry>();
            const now = Date.now();

            for (const [id, value] of Object.entries(json)) {
                if (typeof value === "string") {
                    const current = value.trim();
                    if (current) result.set(id, { current, history: [], lastVerifiedAt: now });
                } else if (Array.isArray(value) && value.length > 0) {
                    const storedAliases = value.map(alias => alias.trim()).filter(Boolean);
                    const current = storedAliases.at(-1);
                    if (!current) continue;
                    const history = uniqueAliases(storedAliases.slice(0, -1))
                        .filter(alias => alias !== current);
                    result.set(id, { current, history, lastVerifiedAt: now });
                }
            }
            return result;
        } catch {
            return new Map();
        }
    }

    private async persistToDisk(): Promise<void> {
        const release = await acquireLock({ lockPath: this.lockPath });
        try {
            const data: Record<string, string[]> = {};
            for (const [id, entry] of this.state) {
                data[id] = [...entry.history, entry.current];
            }

            const tmpPath = this.filePath + ".tmp";
            const dir = path.dirname(this.filePath);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
            await fs.rename(tmpPath, this.filePath);
        } finally {
            await release();
        }
    }
}

function uniqueAliases(aliases: string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();

    for (const rawAlias of aliases) {
        const alias = rawAlias.trim();
        if (!alias || seen.has(alias)) continue;
        seen.add(alias);
        result.push(alias);
    }

    return result;
}

function sameAliases(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((alias, index) => alias === right[index]);
}
