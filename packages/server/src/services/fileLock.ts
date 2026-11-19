import { promises as fs } from "fs";
import * as path from "path";

interface LockOptions {
    lockPath: string;
    staleMs?: number;
    retryMs?: number;
    timeoutMs?: number;
}

interface LockHolder {
    pid: number;
    timestamp: number;
}

export async function acquireLock({
    lockPath,
    staleMs = 30_000,
    retryMs = 50,
    timeoutMs = 5_000,
}: LockOptions): Promise<() => Promise<void>> {
    const holderPath = path.join(lockPath, "holder.json");
    const deadline = Date.now() + timeoutMs;

    while (true) {
        try {
            await fs.mkdir(lockPath);
            const holder: LockHolder = { pid: process.pid, timestamp: Date.now() };
            await fs.writeFile(holderPath, JSON.stringify(holder));

            return async () => {
                try {
                    await fs.unlink(holderPath);
                } catch {}
                try {
                    await fs.rmdir(lockPath);
                } catch {}
            };
        } catch (err: any) {
            if (err.code !== "EEXIST") throw err;

            if (await isStaleLock(lockPath, holderPath, staleMs)) {
                try {
                    await fs.unlink(holderPath);
                } catch {}
                try {
                    await fs.rmdir(lockPath);
                } catch {}
                continue;
            }

            if (Date.now() >= deadline) {
                throw new Error(`Failed to acquire lock at ${lockPath} within ${timeoutMs}ms`);
            }

            await new Promise((r) => setTimeout(r, retryMs));
        }
    }
}

// A lock is stale when its holder is gone or too old. A power cut between creating the
// lock directory and writing the holder leaves no readable holder at all; that lock is
// stale once the directory itself is older than staleMs (a live holder writes within
// milliseconds), so it cannot block every later writer forever.
async function isStaleLock(lockPath: string, holderPath: string, staleMs: number): Promise<boolean> {
    let holder: LockHolder | null = null;
    try {
        const parsed = JSON.parse(await fs.readFile(holderPath, "utf-8"));
        if (Number.isFinite(parsed?.timestamp) && Number.isInteger(parsed?.pid)) holder = parsed;
    } catch {}

    if (!holder) {
        try {
            const { mtimeMs } = await fs.stat(lockPath);
            return Date.now() - mtimeMs > staleMs;
        } catch {
            return false;
        }
    }

    if (Date.now() - holder.timestamp > staleMs) return true;
    try {
        process.kill(holder.pid, 0);
        return false;
    } catch {
        return true;
    }
}
