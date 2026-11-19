import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { CredentialSource, StoredCredentials } from "sdk";

// The services' home-relative state folder, ~/.local/share/video-services. The session
// files, browser profiles and phone handoff files live here whatever
// VIDEO_SERVICES_DATA_ROOT says (pinned: moving them would sign every consumer out).
export function servicesHome(): string {
    return path.join(os.homedir(), ".local", "share", "video-services");
}

// ~/.local/state/video-services: per-account sign-in coordination and diagnostics.
export function servicesStateHome(): string {
    return path.join(os.homedir(), ".local", "state", "video-services");
}

// The accounts the auth daemon keeps signed in (with their passwords), outside any
// checkout: $VIDEO_AUTH_ACCOUNTS_FILE, else ~/.config/video-services/auth-accounts.json.
export function authAccountsPath(): string {
    return process.env.VIDEO_AUTH_ACCOUNTS_FILE ?? path.join(os.homedir(), ".config", "video-services", "auth-accounts.json");
}

// The one reader and writer of the session files: session/<account>.json, the record the
// site's auth serialized plus lastWriteMs. The auth daemon writes them (in order, see
// packages/auth AuthContext); every consumer reads them on each use.
export class CredentialStore {
    constructor(readonly directory: string = path.join(servicesHome(), "session")) {}

    public path(account: string): string {
        return path.resolve(this.directory, `${account}.json`);
    }

    // For consumers: exactly one read; a missing, unreadable or torn file has no record.
    public async read(account: string): Promise<StoredCredentials> {
        const readAtMs = Date.now();
        let raw: string;
        try {
            raw = await fs.readFile(this.path(account), "utf-8");
        } catch {
            return { record: null, writtenAtMs: null, readAtMs };
        }
        let record: unknown;
        try {
            record = JSON.parse(raw);
        } catch {
            return { record: null, writtenAtMs: null, readAtMs };
        }
        if (!record || typeof record !== "object" || Array.isArray(record)) return { record: null, writtenAtMs: null, readAtMs };
        const stored = record as Record<string, unknown>;
        return { record: stored, writtenAtMs: (stored.lastWriteMs ?? null) as number | null, readAtMs };
    }

    // For the auth daemon at start: the record, null when there is no file; any other
    // failure (unreadable, torn) throws for the caller to report.
    public async load(account: string): Promise<Record<string, unknown> | null> {
        try {
            return JSON.parse(await fs.readFile(this.path(account), "utf-8"));
        } catch (error: any) {
            if (error?.code === "ENOENT") return null;
            throw error;
        }
    }

    // Replaces the record durably: a temporary file, flushed, renamed over the old one,
    // then the directory flushed. A rotated refresh token invalidates the previous one,
    // so the new one must be on disk before the save counts as done.
    public async write(account: string, record: Record<string, unknown>): Promise<void> {
        const filePath = this.path(account);
        const serialized = { ...record, lastWriteMs: Date.now() };
        const tmpPath = filePath + ".tmp";
        await fs.writeFile(tmpPath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
        await syncPath(tmpPath);
        await fs.rename(tmpPath, filePath);
        await syncPath(path.dirname(filePath));
    }

    // One account's credentials, for a site's consumers. Without an account there are none.
    public source(account: string | undefined): CredentialSource {
        return {
            read: async () => account ? this.read(account) : { record: null, writtenAtMs: null, readAtMs: Date.now() },
        };
    }
}

// fsync a file or directory through a read-only descriptor (Linux flushes either way).
async function syncPath(target: string): Promise<void> {
    const handle = await fs.open(target, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}
