import * as path from "path";
import logger from "../../common/logger.js";
import * as config from "../../common/config.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";

export class AliasManager {
    private aliases: Map<string, string> = new Map();
    private readonly aliasesFilePath: string;
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
        const aliasesJson = await FileSystemManager.readJsonFile<{ [key: string]: string }>(this.aliasesFilePath);
        if (aliasesJson) {
            this.aliases = new Map(Object.entries(aliasesJson));
            logger.info(`Loaded ${this.aliases.size} aliases from cache.`);
        } else {
            logger.info("aliases.json not found or is invalid. Starting with an empty cache.");
        }
    }

    public get(streamerId: string): string | undefined {
        return this.aliases.get(streamerId);
    }

    public set(streamerId: string, alias: string): void {
        if (this.aliases.get(streamerId) === alias) {
            return;
        }
        this.aliases.set(streamerId, alias);
        this._requestFileUpdate();
    }

    public batchSet(newAliases: { [key: string]: string }): void {
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
            void this._updateAliasesFile();
        }, 500);
    }

    private async _updateAliasesFile(): Promise<void> {
        const aliasesObj = Object.fromEntries(this.aliases);
        await FileSystemManager.writeJsonFile(this.aliasesFilePath, aliasesObj);
    }
}
