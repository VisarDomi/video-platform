import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mp4Identity, mp4RenameName, MP4RenameError, type MP4Rename, type MP4RenameHooks } from "./mp4Identity.js";

const execute = promisify(execFile);
export interface MP4Video { filename: string; fileId: string; type: "original"; size: number; duration: number; isLive: false }
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
    get currentRevision(): number { return this.revision; }
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
    private aliases: Record<string, string> = {};
    private renameHooks: MP4RenameHooks;
    private journalFile: string;
    private aliasesFile: string;
    constructor(readonly directory = path.join(os.homedir(), "Videos/plab/bunkr"), options: { stateFile?: string; probe?: Probe; renameHooks?: MP4RenameHooks } = {}) {
        this.stateFile = options.stateFile ?? path.join(os.homedir(), ".local/share/video-services/bunkr-library/index.json");
        this.probe = options.probe ?? duration;
        this.journalFile = path.join(path.dirname(this.stateFile), "rename-journal.json");
        this.aliasesFile = path.join(path.dirname(this.stateFile), "rename-aliases.json");
        this.renameHooks = options.renameHooks ?? { prepare: async () => [], commit: async () => undefined };
    }
    start(): Promise<void> {
        if (this.started) return this.started;
        const starting = (async () => {
            try {
                const saved = JSON.parse(await readFile(this.stateFile, "utf8"));
                if (saved.version === 1 || saved.version === 2) for (const entry of saved.entries ?? []) {
                    if (mp4Name(entry?.video?.filename)) this.entries.set(entry.video.filename, entry);
                }
            } catch { /* A disposable cache: the directory remains the authority. */ }
            try { this.aliases = JSON.parse(await readFile(this.aliasesFile, "utf8")).aliases ?? {}; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
        const pass = this.scanning.catch(() => undefined).then(async () => { await this.recoverRename(); await this.scan(); });
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
        const seen = new Set<string>();
        for (const filename of names) {
            if (this.closed) return;
            const file = path.join(this.directory, filename);
            let stat;
            try { stat = await lstat(file); } catch { continue; }
            if (!stat.isFile() || stat.size <= 0) continue;
            const fileId = mp4Identity(stat);
            if (seen.has(fileId)) continue;
            const previous = this.entries.get(filename);
            if (previous?.video.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ctimeMs === stat.ctimeMs && previous.inode === stat.ino) {
                found.set(filename, { ...previous, video: { ...previous.video, fileId } }); seen.add(fileId); continue;
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
            found.set(filename, { video: { filename, fileId, type: "original", size: stat.size, duration: Number.isFinite(seconds) && seconds >= 0 ? seconds : 0, isLive: false },
                mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, inode: stat.ino });
            seen.add(fileId);
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
            await writeFile(`${this.stateFile}.tmp`, JSON.stringify({ version: 2, entries: [...this.entries.values()] }));
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
        await this.start();
        await this.scanning.catch(() => undefined);
        if (this.aliases[filename]) return this.fileById(this.aliases[filename]);
        const file = path.join(this.directory, filename);
        const stat = await lstat(file).catch(() => undefined);
        return stat?.isFile() && stat.size > 0 ? file : undefined;
    }
    async videoById(id: string): Promise<MP4Video | undefined> {
        if (!/^[a-f0-9]{24}$/.test(id)) return undefined;
        await this.start(); await this.scanning.catch(() => undefined);
        return [...this.entries.values()].find(entry => entry.video.fileId === id)?.video;
    }
    async fileById(id: string): Promise<string | undefined> {
        if (!/^[a-f0-9]{24}$/.test(id)) return undefined;
        let video = await this.videoById(id);
        if (!video) { await this.refresh(); video = await this.videoById(id); }
        if (!video) return undefined;
        let file = path.join(this.directory, video.filename), stat = await lstat(file).catch(() => undefined);
        if (!stat?.isFile() || mp4Identity(stat) !== id) {
            await this.refresh(); video = await this.videoById(id); if (!video) return undefined;
            file = path.join(this.directory, video.filename); stat = await lstat(file).catch(() => undefined);
        }
        return stat?.isFile() && stat.size > 0 && mp4Identity(stat) === id ? file : undefined;
    }
    private async durableJSON(file: string, value: unknown) {
        await mkdir(path.dirname(file), { recursive: true });
        const handle = await open(`${file}.tmp`, "w", 0o600);
        try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
        await rename(`${file}.tmp`, file); await this.syncDirectory(path.dirname(file));
    }
    private async syncDirectory(directory: string) {
        const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); }
    }
    private async clearJournal() {
        await unlink(this.journalFile).catch(error => { if (error.code !== "ENOENT") throw error; });
        await this.syncDirectory(path.dirname(this.journalFile));
    }
    private async recoverRename() {
        let change: MP4Rename;
        try { change = JSON.parse(await readFile(this.journalFile, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        if (change.version !== 1 || !["prepared", "linked"].includes(change.stage) || !Number.isSafeInteger(change.bytes) || change.bytes <= 0
            || !Array.isArray(change.jobs) || change.jobs.some(id => typeof id !== "string") || !/^[a-f0-9]{24}$/.test(change.fileId)
            || !mp4Name(change.from) || mp4RenameName(change.to) !== change.to || change.from === change.to) {
            throw new Error("Invalid Bunkr rename journal");
        }
        const source = path.join(this.directory, change.from), target = path.join(this.directory, change.to);
        const before = await lstat(source).catch(() => undefined); let after = await lstat(target).catch(() => undefined);
        if (!before && !after) { await this.clearJournal(); return; } // A user removed the media; never restore it.
        if (after && (!after.isFile() || mp4Identity(after) !== change.fileId || after.size !== change.bytes)) {
            if (before?.isFile() && mp4Identity(before) === change.fileId) await this.renameHooks.commit({ ...change, from: change.to, to: change.from });
            await this.clearJournal(); throw new MP4RenameError(409, "A file with that name already exists");
        }
        if (!after && change.stage === "linked") {
            // The destination had already been made durable. Its subsequent removal
            // is a user deletion, not permission to recreate it after a reboot.
            if (before?.isFile() && mp4Identity(before) === change.fileId) {
                await this.renameHooks.commit({ ...change, from: change.to, to: change.from });
            }
            await this.clearJournal(); return;
        }
        if (!after) {
            if (!before?.isFile() || mp4Identity(before) !== change.fileId || before.size !== change.bytes) {
                await this.clearJournal(); throw new MP4RenameError(404, "The video was removed or changed");
            }
            try { await link(source, target); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") { await this.clearJournal(); throw new MP4RenameError(409, "A file with that name already exists"); }
                throw error;
            }
            await this.syncDirectory(this.directory); after = await lstat(target);
        }
        if (change.stage !== "linked") { change.stage = "linked"; await this.durableJSON(this.journalFile, change); }
        await this.renameHooks.commit(change);
        this.aliases[change.from] = change.fileId;
        await this.durableJSON(this.aliasesFile, { version: 1, aliases: this.aliases });
        const currentTarget = await lstat(target).catch(() => undefined), currentSource = await lstat(source).catch(() => undefined);
        if (!currentTarget?.isFile() || mp4Identity(currentTarget) !== change.fileId) throw new MP4RenameError(409, "The video changed during rename");
        if (currentSource?.isFile() && mp4Identity(currentSource) === change.fileId) { await unlink(source); await this.syncDirectory(this.directory); }
        await this.clearJournal();
    }
    async renameFile(id: string, expected: unknown, requested: unknown): Promise<MP4Video> {
        const name = mp4RenameName(requested); await this.start();
        const operation = this.scanning.catch(() => undefined).then(async () => {
            await this.recoverRename(); await this.scan();
            const current = [...this.entries.values()].find(entry => entry.video.fileId === id)?.video;
            if (!current) throw new MP4RenameError(404, "The video no longer exists");
            if (current.filename === name) return current; // Safe acknowledgement retry.
            if (current.filename !== expected) throw new MP4RenameError(409, "The filename changed; refresh it before renaming");
            if (await lstat(path.join(this.directory, name)).catch(() => undefined)) throw new MP4RenameError(409, "A file with that name already exists");
            const jobs = await this.renameHooks.prepare(current.filename, name, id, current.size);
            const change: MP4Rename = { version: 1, fileId: id, from: current.filename, to: name, bytes: current.size, jobs, stage: "prepared" };
            await this.durableJSON(this.journalFile, change); await this.recoverRename(); await this.scan();
            return [...this.entries.values()].find(entry => entry.video.fileId === id)!.video;
        });
        this.scanning = operation.then(() => undefined, () => undefined); return operation;
    }
    async stop() {
        this.closed = true; clearInterval(this.timer); clearTimeout(this.debounce); this.watcher?.close();
        for (const done of [...this.waiters]) done();
        await this.scanning.catch(() => undefined);
    }
}
