// src/common/aliasManager.ts
import * as fsPromises from "fs/promises";
import * as path from "path";
import logger from "./logger.js";
import * as config from "./config.js";

export class AliasManager {
    private aliases: Map<string, string> = new Map();
    private aliasesFilePath: string;
    private _updateFileDebounceTimer: NodeJS.Timeout | null = null;

    private constructor() {
        const cfg = config.getConfig();
        this.aliasesFilePath = path.join(cfg.sharedStatePath, "aliases.json");
        logger.info(`AliasManager initialized. Aliases file: ${this.aliasesFilePath}`);
    }

    public static async create(): Promise<AliasManager> {
        const instance = new AliasManager();
        await instance._loadAliases();
        return instance;
    }

    private async _loadAliases(): Promise<void> {
        try {
            const data = await fsPromises.readFile(this.aliasesFilePath, "utf-8");
            const aliasesJson = JSON.parse(data);
            this.aliases = new Map(Object.entries(aliasesJson));
            logger.info(`Loaded ${this.aliases.size} aliases from cache.`);
        } catch (error: any) {
            if (error.code === "ENOENT") {
                logger.info("aliases.json not found. Starting with an empty cache.");
            } else {
                logger.error("Failed to load aliases from file.", { error });
            }
        }
    }

    public get(streamerId: string): string | undefined {
        return this.aliases.get(streamerId);
    }

    public set(streamerId: string, alias: string): void {
        if (this.aliases.get(streamerId) === alias) {
            return; // No change
        }
        this.aliases.set(streamerId, alias);
        this._requestFileUpdate();
    }

    public batchSet(newAliases: { [key: string]: string }): void {
        // We merge, prioritizing new aliases
        for (const [streamerId, alias] of Object.entries(newAliases)) {
            this.aliases.set(streamerId, alias);
        }
        this._requestFileUpdate();
    }

    private _requestFileUpdate(): void {
        if (this._updateFileDebounceTimer) {
            clearTimeout(this._updateFileDebounceTimer);
        }
        this._updateFileDebounceTimer = setTimeout(() => {
            this._updateAliasesFile();
        }, 500); // Wait 500ms before writing
    }

    private async _updateAliasesFile(): Promise<void> {
        try {
            const aliasesObj = Object.fromEntries(this.aliases);
            await fsPromises.writeFile(this.aliasesFilePath, JSON.stringify(aliasesObj, null, 2));
        } catch (error) {
            logger.error("Failed to write aliases to aliases.json", { error });
        }
    }
}
