import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface MP4Video { filename: string; type: "original"; size: number; duration: number; isLive: false }
interface Entry { video: MP4Video; mtimeMs: number; ctimeMs: number; inode: number }
interface Change { revision: number; item?: MP4Video; removed?: { filename: string; type: "original" } }
type Probe = (filename: string) => Promise<number>;
export function mp4Name(filename: unknown): filename is string {
    return typeof filename === "string" && !filename.startsWith(".") && !/[\x00/\\]/.test(filename) && /\.mp4$/i.test(filename);
}
async function duration(filename: string): Promise<number> {
    const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", filename], { timeout: 15_000, maxBuffer: 64 * 1024 });
    const value = Number(JSON.parse(stdout)?.format?.duration);
    return Number.isFinite(value) && value >= 0 ? value : 0;
}

// The same revision/long-poll contract as recording lists, with flat completed MP4 files.
// Metadata is cached by stat fingerprint. Playback always streams the original file.
export class MP4Library {
    readonly epoch = randomUUID();
    private revision = 0;
    private entries = new Map<string, Entry>();
    private log: Change[] = [];
    private waiters = new Set<() => void>();
    private watcher?: FSWatcher;
    private watchedDirectory?: string;
    private timer?: NodeJS.Timeout;
    private debounce?: NodeJS.Timeout;
    private started?: Promise<void>;
    private scanning: Promise<void> = Promise.resolve();
    private closed = false;
    private stateFile: string;
    private probe: Probe;
    constructor(readonly directory = path.join(os.homedir(), "Videos/plab/bunkr"), options: { stateFile?: string; probe?: Probe } = {}) {
        this.stateFile = options.stateFile ?? path.join(os.homedir(), ".local/share/video-services/bunkr-library/index.json");
        this.probe = options.probe ?? duration;
    }
    start(): Promise<void> {
        if (this.started) return this.started;
        const starting = (async () => {
            try {
                const saved = JSON.parse(await readFile(this.stateFile, "utf8"));
                if (saved.version === 1) for (const entry of saved.entries ?? []) {
                    if (mp4Name(entry?.video?.filename)) this.entries.set(entry.video.filename, entry);
                }
            } catch { /* A disposable cache: the directory remains the authority. */ }
            await this.refresh();
            this.timer = setInterval(() => void this.refresh().catch(error => console.error("Bunkr library rescan:", error.message)), 30_000);
            this.timer.unref();
        })();
        this.started = starting;
        void starting.catch(() => { if (this.started === starting) this.started = undefined; });
        return starting;
    }
    private follow(identity: string | undefined) {
        if (!identity || this.watcher || this.closed) return;
        try {
            this.watcher = watch(this.directory, { persistent: false }, (_event, name) => {
                // A large .part writes continuously; only publication or a completed-file change matters.
                if (name && !mp4Name(String(name))) return;
                if (this.debounce) return;
                this.debounce = setTimeout(() => {
                    this.debounce = undefined;
                    void this.refresh().catch(error => console.error("Bunkr library update:", error.message));
                }, 100);
            });
            this.watchedDirectory = identity;
            this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
        } catch { /* A folder recreated later is found by the safety scan. */ }
    }
    refresh(): Promise<void> {
        const pass = this.scanning.catch(() => undefined).then(() => this.scan());
        this.scanning = pass; return pass;
    }
    private async scan() {
        if (this.closed) return;
        const directory = await lstat(this.directory).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        const identity = directory?.isDirectory() ? `${directory.dev}:${directory.ino}` : undefined;
        if (this.watcher && identity !== this.watchedDirectory) { this.watcher.close(); this.watcher = undefined; }
        let names: string[];
        try { names = (await readdir(this.directory, { withFileTypes: true })).filter(entry => entry.isFile() && mp4Name(entry.name)).map(entry => entry.name).sort(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
        const found = new Map<string, Entry>();
        for (const filename of names) {
            if (this.closed) return;
            const file = path.join(this.directory, filename);
            let stat;
            try { stat = await lstat(file); } catch { continue; }
            if (!stat.isFile() || stat.size <= 0) continue;
            const previous = this.entries.get(filename);
            if (previous?.video.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ctimeMs === stat.ctimeMs && previous.inode === stat.ino) {
                found.set(filename, previous); continue;
            }
            let seconds = 0;
            try { seconds = await this.probe(file); }
            catch { console.warn("Bunkr MP4 metadata unavailable:", filename); }
            const after = await lstat(file).catch(() => undefined);
            if (!after?.isFile() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) {
                // Do not replace a stable row with metadata read while a file was changing.
                if (previous && after?.isFile()) found.set(filename, previous);
                continue;
            }
            found.set(filename, { video: { filename, type: "original", size: stat.size, duration: Number.isFinite(seconds) && seconds >= 0 ? seconds : 0, isLive: false },
                mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, inode: stat.ino });
        }
        let changed = false;
        for (const [filename, entry] of found) {
            if (JSON.stringify(this.entries.get(filename)?.video) === JSON.stringify(entry.video)) continue;
            this.record({ item: entry.video }); changed = true;
        }
        for (const filename of this.entries.keys()) if (!found.has(filename)) { this.record({ removed: { filename, type: "original" } }); changed = true; }
        const fingerprintsChanged = JSON.stringify([...this.entries]) !== JSON.stringify([...found]);
        this.entries = found;
        if (fingerprintsChanged) await this.save();
        if (changed) for (const done of [...this.waiters]) done();
        this.follow(identity);
    }
    private record(change: Omit<Change, "revision">) {
        this.log.push({ ...change, revision: ++this.revision });
        if (this.log.length > 5000) this.log.splice(0, this.log.length - 5000);
    }
    private async save() {
        try {
            await mkdir(path.dirname(this.stateFile), { recursive: true });
            await writeFile(`${this.stateFile}.tmp`, JSON.stringify({ version: 1, entries: [...this.entries.values()] }));
            const handle = await open(`${this.stateFile}.tmp`, "r"); try { await handle.sync(); } finally { await handle.close(); }
            await rename(`${this.stateFile}.tmp`, this.stateFile);
        } catch (error) { console.warn("Bunkr library cache could not save:", (error as Error).message); }
    }
    async videos(after?: string): Promise<MP4Video[]> {
        await this.start();
        return [...this.entries.values()].map(entry => entry.video).filter(video => !after || video.filename > after).sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
    }
    async changes(since: number | undefined, epoch: string | undefined, waitMs = 0, signal?: AbortSignal) {
        await this.start();
        if (since === undefined || epoch !== this.epoch || since > this.revision || since < (this.log[0]?.revision ?? this.revision + 1) - 1) {
            return { epoch: this.epoch, revision: this.revision, videos: await this.videos() };
        }
        if (since === this.revision && waitMs > 0 && !signal?.aborted) await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, Math.min(25_000, waitMs));
            this.waiters.add(done); signal?.addEventListener("abort", done, { once: true });
            if (signal?.aborted) done();
        });
        return { epoch: this.epoch, revision: this.revision, changes: this.log.filter(change => change.revision > since) };
    }
    async file(filename: unknown): Promise<string | undefined> {
        if (!mp4Name(filename)) return undefined;
        const file = path.join(this.directory, filename);
        const stat = await lstat(file).catch(() => undefined);
        return stat?.isFile() && stat.size > 0 ? file : undefined;
    }
    async stop() {
        this.closed = true; clearInterval(this.timer); clearTimeout(this.debounce); this.watcher?.close();
        for (const done of [...this.waiters]) done();
        await this.scanning.catch(() => undefined);
    }
}
