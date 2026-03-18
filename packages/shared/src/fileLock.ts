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
            // Lock acquired — write holder info
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

            // Lock dir exists — check if stale
            try {
                const raw = await fs.readFile(holderPath, "utf-8");
                const holder: LockHolder = JSON.parse(raw);

                let isStale = Date.now() - holder.timestamp > staleMs;

                if (!isStale) {
                    // Check if holding process is still alive
                    try {
                        process.kill(holder.pid, 0);
                    } catch {
                        isStale = true;
                    }
                }

                if (isStale) {
                    // Remove stale lock and retry immediately
                    try {
                        await fs.unlink(holderPath);
                    } catch {}
                    try {
                        await fs.rmdir(lockPath);
                    } catch {}
                    continue;
                }
            } catch {
                // Can't read holder — might be mid-creation, just retry
            }

            if (Date.now() >= deadline) {
                throw new Error(`Failed to acquire lock at ${lockPath} within ${timeoutMs}ms`);
            }

            await new Promise((r) => setTimeout(r, retryMs));
        }
    }
}
