import { execFile } from "node:child_process";
import { open as openFile, realpath, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { UplinkSetting } from "sdk";

const run = promisify(execFile);

// The removable drive that carries converted files to the other uplink, as the PC sees it:
// is it there, open it (mounted) and give its root, how much room it has, close it (flushed
// and, for a drive, unmounted). Every call may fail because the drive was pulled; callers
// treat any error as "the drive is gone".
export interface Carrier {
    // The ID its carrier.json names: the drive's label, or a directory carrier's folder name.
    readonly id: string;
    present(): Promise<boolean>;
    open(): Promise<string>;
    freeBytes(root: string): Promise<number>;
    close(root: string): Promise<void>;
}

async function syncPath(target: string): Promise<void> {
    const handle = await openFile(target, "r");
    try { await handle.sync(); } finally { await handle.close(); }
}

async function free(root: string): Promise<number> {
    const space = await statfs(root);
    return space.bavail * space.bsize;
}

// A plain directory (tests, simulations).
export class DirectoryCarrier implements Carrier {
    readonly id: string;
    constructor(private readonly directory: string) { this.id = path.basename(directory); }
    async present(): Promise<boolean> { return await stat(this.directory).then((info) => info.isDirectory(), () => false); }
    async open(): Promise<string> {
        if (!await this.present()) throw new Error(`carrier ${this.id}: ${this.directory} is not there`);
        return this.directory;
    }
    freeBytes(root: string): Promise<number> { return free(root); }
    async close(root: string): Promise<void> { await syncPath(root); }
}

// A drive found by its filesystem label, mounted through UDisks (no root needed) only while
// the PC works on it. Mounted already (the desktop mounts a plugged drive by itself) is used
// as it is. Closing flushes the filesystem and unmounts it, so pulling the drive between
// passes loses nothing.
export class LabelCarrier implements Carrier {
    constructor(readonly id: string, private readonly byLabel = "/dev/disk/by-label") {}

    private async device(): Promise<string> { return await realpath(path.join(this.byLabel, this.id)); }

    async present(): Promise<boolean> { return await this.device().then(() => true, () => false); }

    private async mountPoint(device: string): Promise<string | null> {
        const { stdout } = await run("findmnt", ["-n", "-o", "TARGET", "--source", device], { timeout: 10_000 }).catch(() => ({ stdout: "" }));
        return stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
    }

    async open(): Promise<string> {
        const device = await this.device();
        const mounted = await this.mountPoint(device);
        if (mounted) return mounted;
        const { stdout } = await run("udisksctl", ["mount", "-b", device, "--no-user-interaction"], { timeout: 60_000 });
        const at = stdout.match(/ at (.+?)\.?\s*$/m)?.[1];
        if (at) return at;
        const after = await this.mountPoint(device);
        if (!after) throw new Error(`carrier ${this.id}: mounted, but its mount point is unknown`);
        return after;
    }

    freeBytes(root: string): Promise<number> { return free(root); }

    async close(root: string): Promise<void> {
        await run("sync", ["-f", root], { timeout: 120_000 });
        const device = await this.device();
        // A file manager may hold it open: it stays mounted (and flushed) then.
        await run("udisksctl", ["unmount", "-b", device, "--no-user-interaction"], { timeout: 60_000 }).catch(() => undefined);
    }
}

export function carrierFor(uplink: UplinkSetting): Carrier {
    return uplink.carrier.label ? new LabelCarrier(uplink.carrier.label) : new DirectoryCarrier(uplink.carrier.path!);
}

// A name a carrier file may have: a plain name exFAT (and macOS) accepts.
export function carrierFileNameOk(name: string): boolean {
    return name.length > 0 && name.length <= 255 && name === path.basename(name) && !name.startsWith(".")
        && !/[\u0000-\u001f"*/:<>?\\|]/.test(name) && !/[. ]$/.test(name);
}
