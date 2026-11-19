import { promises as fs } from "fs";
import path from "path";

// Replace a file so that a power cut leaves either the old or the new bytes, never a
// truncated mix: write a sibling temporary file, flush it, rename it over the target,
// then flush the directory so the rename itself survives.
export async function writeFileAtomic(filePath: string, content: string, mode?: number): Promise<void> {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    let handle;
    try {
        handle = await fs.open(tmpPath, "wx", mode);
        await handle.writeFile(content, "utf-8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(tmpPath, filePath);
        await syncDirectory(path.dirname(filePath));
    } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(tmpPath).catch(() => {});
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

const fileQueues = new Map<string, Promise<unknown>>();

// Read-modify-write of one text file, serialized per path within this process so two
// requests cannot both read the old content and the second write drop the first change.
// `change` gets the current content (null when the file does not exist) and returns the
// new content, or null to leave the file untouched, plus a result for the caller.
export function mutateTextFile<T>(
    filePath: string,
    change: (current: string | null) => { next: string | null; result: T },
): Promise<T> {
    const key = path.resolve(filePath);
    const run = async (): Promise<T> => {
        let current: string | null = null;
        try {
            current = await fs.readFile(key, "utf-8");
        } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
        }
        const { next, result } = change(current);
        if (next !== null && next !== current) await writeFileAtomic(key, next);
        return result;
    };
    const previous = fileQueues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(run);
    fileQueues.set(key, task);
    task.finally(() => { if (fileQueues.get(key) === task) fileQueues.delete(key); }).catch(() => {});
    return task;
}
