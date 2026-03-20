import { promises as fs } from "fs";
import * as path from "path";
import { acquireLock } from "./fileLock.js";

type AliasMap = Record<string, string[]>;

export class AliasManager {
    private readonly filePath: string;
    private readonly lockPath: string;

    constructor(aliasesFilePath: string) {
        this.filePath = aliasesFilePath;
        this.lockPath = aliasesFilePath + ".lock";
    }

    async get(streamerId: string): Promise<string | undefined> {
        const data = await this._read();
        const arr = data[streamerId];
        return arr ? arr[arr.length - 1] : undefined;
    }

    async getAll(): Promise<Record<string, string[]>> {
        return this._read();
    }

    async getReverse(): Promise<Record<string, string>> {
        const data = await this._read();
        const reverse: Record<string, string> = {};
        for (const [accountId, aliases] of Object.entries(data)) {
            for (const alias of aliases) {
                reverse[alias] = accountId;
            }
        }
        return reverse;
    }

    async set(streamerId: string, alias: string): Promise<void> {
        const release = await acquireLock({ lockPath: this.lockPath });
        try {
            const data = await this._read();
            const arr = data[streamerId];
            if (arr) {
                if (arr[arr.length - 1] === alias) return;
                if (!arr.includes(alias)) {
                    arr.push(alias);
                }
            } else {
                data[streamerId] = [alias];
            }
            await this._write(data);
        } finally {
            await release();
        }
    }

    async batchSet(newAliases: Record<string, string>): Promise<void> {
        const release = await acquireLock({ lockPath: this.lockPath });
        try {
            const data = await this._read();
            for (const [streamerId, alias] of Object.entries(newAliases)) {
                const arr = data[streamerId];
                if (arr) {
                    if (!arr.includes(alias)) {
                        arr.push(alias);
                    }
                } else {
                    data[streamerId] = [alias];
                }
            }
            await this._write(data);
        } finally {
            await release();
        }
    }

    private async _read(): Promise<AliasMap> {
        try {
            const raw = await fs.readFile(this.filePath, "utf-8");
            const json: Record<string, string | string[]> = JSON.parse(raw);
            const result: AliasMap = {};
            for (const [id, value] of Object.entries(json)) {
                result[id] = typeof value === "string" ? [value] : value;
            }
            return result;
        } catch {
            return {};
        }
    }

    private async _write(data: AliasMap): Promise<void> {
        const tmpPath = this.filePath + ".tmp";
        const dir = path.dirname(this.filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
        await fs.rename(tmpPath, this.filePath);
    }
}
