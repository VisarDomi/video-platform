import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// The only durable state a plug-in has. Keys map to JSON files in the plug-in's state
// directory, replaced atomically and flushed (file, rename, directory), so a power cut
// leaves the previous value or the new one, never a torn file.
export interface PluginStore {
    read<T>(key: string): Promise<T | undefined>;
    // Durable when it resolves.
    write<T>(key: string, value: T): Promise<void>;
    // Read-modify-write, serialized per key within this process.
    update<T>(key: string, change: (current: T | undefined) => T): Promise<T>;
    delete(key: string): Promise<void>;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class FilePluginStore implements PluginStore {
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(private readonly directory: string) {}

    async read<T>(key: string): Promise<T | undefined> {
        try {
            return JSON.parse(await fs.readFile(this.file(key), "utf-8")) as T;
        } catch (error: any) {
            if (error?.code === "ENOENT") return undefined;
            throw error;
        }
    }

    write<T>(key: string, value: T): Promise<void> {
        return this.serialize(key, () => this.replace(key, value));
    }

    update<T>(key: string, change: (current: T | undefined) => T): Promise<T> {
        return this.serialize(key, async () => {
            const next = change(await this.read<T>(key));
            await this.replace(key, next);
            return next;
        });
    }

    delete(key: string): Promise<void> {
        return this.serialize(key, async () => {
            await fs.rm(this.file(key), { force: true });
            await syncDirectory(this.directory);
        });
    }

    private file(key: string): string {
        if (!KEY.test(key)) throw new Error(`Invalid store key: ${JSON.stringify(key)}`);
        return path.join(this.directory, `${key}.json`);
    }

    private async replace<T>(key: string, value: T): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true });
        await writeFileDurably(this.file(key), JSON.stringify(value, null, 2) + "\n");
    }

    private serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(key) ?? Promise.resolve();
        const task = previous.catch(() => {}).then(run);
        this.queues.set(key, task);
        task.finally(() => { if (this.queues.get(key) === task) this.queues.delete(key); }).catch(() => {});
        return task;
    }
}

export async function writeFileDurably(filePath: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
        handle = await fs.open(temporary, "wx", mode);
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporary, filePath);
        await syncDirectory(path.dirname(filePath));
    } catch (error) {
        await handle?.close().catch(() => {});
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

export async function syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}
