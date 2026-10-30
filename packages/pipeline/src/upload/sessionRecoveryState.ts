import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface RecoveryState {
    version: 1;
    failures: number;
    retryAfter?: string;
    status?: string;
    lastError?: string;
}
export class RecoveryDeferredError extends Error {}
export const recoveryLockPath = (databasePath: string) => path.join(path.dirname(databasePath), 'porntrex-recovery.lock');
export const recoveryStatePath = (databasePath: string) => path.join(path.dirname(databasePath), 'porntrex-recovery.json');
export async function recoveryInProgress(databasePath: string): Promise<boolean> {
    const target = recoveryLockPath(databasePath);
    if (!await fs.stat(target).then(() => true, () => false)) return false;
    const result = spawnSync('flock', ['-n', target, 'true'], { stdio: 'ignore', timeout: 2_000 });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error('Could not inspect session recovery lock');
    return result.status === 1;
}
export async function readRecoveryState(databasePath: string): Promise<RecoveryState> {
    try {
        const value = JSON.parse(await fs.readFile(recoveryStatePath(databasePath), 'utf8'));
        if (value.version !== 1 || !Number.isInteger(value.failures) || value.failures < 0) throw new Error();
        return value;
    } catch { return { version: 1, failures: 0 }; }
}
export async function writeRecoveryState(databasePath: string, state: RecoveryState): Promise<void> {
    const target = recoveryStatePath(databasePath), temporary = `${target}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
        await fs.writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
        const handle = await fs.open(temporary, 'r'); try { await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, target);
        const directory = await fs.open(path.dirname(target), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await fs.unlink(temporary).catch(() => {}); }
}

// A kernel flock is held by a tiny pipe-bound process. Closing the pipe (also
// on parent SIGKILL) releases it; persistent files/PID reuse cannot strand it.
export async function withRecoveryLock<T>(databasePath: string, action: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> {
    await fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const target = recoveryLockPath(databasePath);
    const file = await fs.open(target, 'a', 0o600); await file.close();
    const keeper = spawn('flock', ['-n', '--no-fork', target, 'sh', '-c', 'printf "locked\\n"; read -r release || :'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
    keeper.stdin.on('error', () => {}); // A nonblocking loser may exit before cleanup writes.
    let releasing = false, acquired = false;
    const closed = new Promise<number | null>((resolve, reject) => {
        keeper.once('error', reject);
        keeper.once('close', code => {
            if (acquired && !releasing) {
                // Never continue a credential operation after losing exclusivity.
                process.kill(process.pid, 'SIGTERM');
            }
            resolve(code);
        });
    });
    const ready = new Promise<boolean>((resolve, reject) => {
        keeper.stdout.once('data', () => { acquired = true; resolve(true); });
        keeper.once('error', reject);
        keeper.once('close', code => code === 1 ? resolve(false)
            : !acquired && reject(new Error('Could not acquire session recovery lock')));
    });
    try {
        if (!await ready) return { acquired: false };
        return { acquired: true, value: await action() };
    } finally {
        releasing = true;
        if (!keeper.stdin.destroyed) keeper.stdin.end('release\n');
        await closed;
    }
}
