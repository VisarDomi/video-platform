import { randomUUID } from "crypto";
import { promises as fs, watch, type FSWatcher } from "fs";
import path from "path";
import zlib from "zlib";
import * as config from "../../core/config.js";
import * as constants from "../../core/constants.js";
import * as types from "../../core/types.js";
import logger from "../../core/logger.js";

// Each provider's recordings, kept instead of rescanned for every request. The list used to
// be rebuilt per request (three directory scans, a stat per recording, playlists re-read
// after a restart) and sent whole (450 KB for Tango's 4,000 recordings, uncompressed) to every
// refresh. Now:
// - the index lives in memory and on disk (<shared state>/list-index/<provider>.json, written
//   atomically), so a restart rescans with stats only and reads only playlists that changed;
// - it follows the folders as they change (inotify watches, debounced, plus a periodic stat
//   rescan in case an event is lost), so a new recording, a finished one, an edit or a deletion
//   shows up within a second;
// - every change has a revision; `changes(since)` answers with only what changed (or waits for
//   the next change: long polling), and the full list is encoded and gzipped once per revision.
// Order is plain code-unit order of the filename (as `after` compares), then the type, so a
// client can place a changed row itself.

type Kind = "live" | "original" | "edited";
interface Entry extends types.VideoItem {
    kind: Kind;
    // The playlist's stat when its duration was read; an unchanged stat reuses the duration.
    mtimeMs: number;
    bytes: number;
}
export interface Change {
    revision: number;
    item?: types.VideoItem;
    removed?: { filename: string; type: types.VideoType };
}
export interface ChangeSet {
    // Revisions are only comparable within one epoch (one run of the server: a crash before
    // the last save could hand out a revision again); another epoch gets the full list.
    epoch: string;
    revision: number;
    // Present instead of `changes` when the client is too far behind (or new).
    videos?: types.VideoItem[];
    changes?: Change[];
}

const KEEP_CHANGES = 5000;
const EPOCH = randomUUID();
const SAFETY_RESCAN_MS = 30_000;
const ACTIVE_RESCAN_MS = 2_000;
const DEBOUNCE_MS = 150;

export function key(filename: string, type: string): string { return filename + "\u001f" + type; }

export function compareVideos(a: types.VideoItem, b: types.VideoItem): number {
    if (a.filename !== b.filename) return a.filename < b.filename ? -1 : 1;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
}

// The playlist's duration: the sum of its #EXTINF values (as the Go helper summed them).
export function playlistDuration(text: string): number {
    let duration = 0;
    for (const line of text.split("\n")) {
        if (!line.startsWith("#EXTINF:")) continue;
        const value = line.slice(8).split(",")[0].replace(/\r$/, "");
        const seconds = Number(value);
        if (value !== "" && Number.isFinite(seconds)) duration += seconds;
    }
    return duration;
}

function item(entry: Entry): types.VideoItem {
    return { filename: entry.filename, type: entry.type, size: 0, duration: entry.duration, isLive: entry.isLive };
}

export class ProviderIndex {
    private entries = new Map<string, Entry>();
    private revision = 0;
    private changeLog: Change[] = [];
    private encoded: { revision: number; json: Buffer; gzip: Buffer } | null = null;
    private waiters = new Set<() => void>();
    private watchers: FSWatcher[] = [];
    private timers: NodeJS.Timeout[] = [];
    private pending: NodeJS.Timeout | null = null;
    private reconciling: Promise<void> = Promise.resolve();
    private saveTimer: NodeJS.Timeout | null = null;
    private started: Promise<void> | null = null;

    constructor(
        readonly provider: string,
        private readonly dirs: { live: string; original: string; edited: string },
        private readonly stateFile: string,
    ) {}

    static forProvider(provider: string): ProviderIndex {
        const paths = config.getProviderPaths(provider);
        return new ProviderIndex(provider, { live: path.join(paths.downloaded, ".active"), original: paths.downloaded, edited: paths.edited },
            path.join(config.SHARED_STATE_PATH, "list-index", provider + ".json"));
    }

    start(): Promise<void> {
        this.started ??= (async () => {
            await this.load();
            await this.reconcile();
            this.watch();
            this.timers.push(setInterval(() => void this.reconcile(), SAFETY_RESCAN_MS).unref());
            // A live recording's folder appears before its playlist: watch for the playlist.
            this.timers.push(setInterval(() => void this.reconcile(["live"]), ACTIVE_RESCAN_MS).unref());
        })();
        return this.started;
    }

    // Stops following the folders; a save still due is written first.
    async stop(): Promise<void> {
        this.watchers.forEach(watcher => watcher.close());
        this.timers.forEach(clearInterval);
        if (this.pending) clearTimeout(this.pending);
        this.watchers = [];
        this.timers = [];
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
            await this.save();
        }
    }

    // The list in order; `after`: only names after it (the website's polling).
    async videos(after?: string): Promise<types.VideoItem[]> {
        await this.start();
        const all = this.sorted();
        return after ? all.filter(video => video.filename > after) : all;
    }

    // The whole list, encoded once per revision (and gzipped).
    async encodedList(): Promise<{ revision: number; json: Buffer; gzip: Buffer }> {
        await this.start();
        if (this.encoded?.revision !== this.revision) {
            const json = Buffer.from(JSON.stringify(this.sorted()));
            this.encoded = { revision: this.revision, json, gzip: zlib.gzipSync(json) };
        }
        return this.encoded;
    }

    // What changed after `since` (of `epoch`); waits up to `waitMs` for a change when nothing has.
    async changes(since: number | undefined, epoch: string | undefined, waitMs = 0): Promise<ChangeSet> {
        await this.start();
        if (since === undefined || epoch !== EPOCH || since > this.revision || (this.changeLog[0] && since < this.changeLog[0].revision - 1)
            || (!this.changeLog.length && since < this.revision)) {
            return { epoch: EPOCH, revision: this.revision, videos: this.sorted() };
        }
        if (since === this.revision && waitMs > 0) {
            await new Promise<void>(resolve => {
                const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
                const timer = setTimeout(done, waitMs);
                this.waiters.add(done);
            });
        }
        return { epoch: EPOCH, revision: this.revision, changes: this.changeLog.filter(change => change.revision > since) };
    }

    get currentRevision(): number { return this.revision; }
    get epoch(): string { return EPOCH; }

    // A change made by this server (an edit, a move): reflect it now, not on the next event.
    refresh(): Promise<void> { return this.reconcile(); }

    private sorted(): types.VideoItem[] {
        return [...this.entries.values()].map(item).sort(compareVideos);
    }

    private async load(): Promise<void> {
        try {
            const saved = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as { revision: number; entries: Entry[] };
            this.revision = Number.isSafeInteger(saved.revision) ? saved.revision : 0;
            for (const entry of saved.entries ?? []) this.entries.set(key(entry.filename, entry.type), entry);
        } catch { /* First start, or an unreadable file: rebuilt from the folders. */ }
    }

    private scheduleSave(): void {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.save();
        }, 1000);
        this.saveTimer.unref();
    }

    private async save(): Promise<void> {
        const data = JSON.stringify({ revision: this.revision, entries: [...this.entries.values()] });
        const temporary = this.stateFile + ".tmp";
        try {
            await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
            const handle = await fs.open(temporary, "w");
            try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
            await fs.rename(temporary, this.stateFile);
        } catch (error) {
            logger.warn(`[list-index] ${this.provider}: could not save`, { error });
        }
    }

    private watch(): void {
        for (const [kind, dir] of Object.entries(this.dirs) as [Kind, string][]) {
            try {
                const watcher = watch(dir, { persistent: false }, () => this.debounce(kind));
                watcher.on("error", () => { /* The safety rescan covers a lost watch. */ });
                this.watchers.push(watcher);
            } catch { /* A missing folder (no recordings yet): the rescans cover it. */ }
        }
    }

    private dirty = new Set<Kind>();
    private debounce(kind: Kind): void {
        this.dirty.add(kind);
        if (this.pending) return;
        this.pending = setTimeout(() => {
            this.pending = null;
            const kinds = [...this.dirty];
            this.dirty.clear();
            void this.reconcile(kinds);
        }, DEBOUNCE_MS);
    }

    // Brings the entries of the given folders in line with the disk, one pass at a time.
    private reconcile(kinds: Kind[] = ["live", "original", "edited"]): Promise<void> {
        this.reconciling = this.reconciling.then(() => this.reconcileNow(kinds)).catch(error => {
            logger.warn(`[list-index] ${this.provider}: rescan failed`, { error });
        });
        return this.reconciling;
    }

    private async reconcileNow(kinds: Kind[]): Promise<void> {
        // A finished recording (downloaded) replaces its live entry; scan both together.
        const scan = new Set<Kind>(kinds);
        if (scan.has("live") || scan.has("original")) { scan.add("live"); scan.add("original"); }
        const found = new Map<string, Entry>();
        for (const kind of ["live", "original", "edited"] as Kind[]) {
            if (!scan.has(kind)) continue;
            let names: string[] = [];
            try {
                names = (await fs.readdir(this.dirs[kind], { withFileTypes: true }))
                    .filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => entry.name);
            } catch { continue; }
            await Promise.all(names.map(async name => {
                const entry = await this.read(kind, name);
                if (entry) found.set(key(entry.filename, entry.type), entry);
            }));
        }
        let changed = false;
        for (const [entryKey, entry] of found) {
            const existing = this.entries.get(entryKey);
            if (existing && existing.duration === entry.duration && existing.isLive === entry.isLive && existing.kind === entry.kind) {
                existing.mtimeMs = entry.mtimeMs;
                existing.bytes = entry.bytes;
                continue;
            }
            this.entries.set(entryKey, entry);
            this.record({ item: item(entry) });
            changed = true;
        }
        for (const [entryKey, entry] of this.entries) {
            if (!scan.has(entry.kind) || found.has(entryKey)) continue;
            this.entries.delete(entryKey);
            this.record({ removed: { filename: entry.filename, type: entry.type } });
            changed = true;
        }
        if (changed) {
            this.scheduleSave();
            for (const waiter of [...this.waiters]) waiter();
        }
    }

    // One recording's entry: a live one counts once its playlist exists; others get their
    // duration from the playlist, read only when its stat changed.
    private async read(kind: Kind, name: string): Promise<Entry | null> {
        const playlist = path.join(this.dirs[kind], name, constants.FILE_NAMES.HLS_PLAYLIST);
        const type = kind === "edited" ? constants.ALL_VIDEO_PATHS_TYPES.EDITED : constants.ALL_VIDEO_PATHS_TYPES.ORIGINAL;
        let stat;
        try { stat = await fs.stat(playlist); } catch { return kind === "live" ? null : { filename: name, type, size: 0, duration: 0, isLive: false, kind, mtimeMs: 0, bytes: 0 }; }
        if (kind === "live") return { filename: name, type, size: 0, duration: 0, isLive: true, kind, mtimeMs: 0, bytes: 0 };
        const previous = this.entries.get(key(name, type));
        let duration = previous?.duration ?? 0;
        if (!previous || previous.kind !== kind || previous.mtimeMs !== stat.mtimeMs || previous.bytes !== stat.size) {
            try { duration = playlistDuration(await fs.readFile(playlist, "utf8")); } catch { duration = 0; }
        }
        return { filename: name, type, size: 0, duration, isLive: false, kind, mtimeMs: stat.mtimeMs, bytes: stat.size };
    }

    private record(change: Omit<Change, "revision">): void {
        this.revision += 1;
        this.changeLog.push({ revision: this.revision, ...change });
        if (this.changeLog.length > KEEP_CHANGES) this.changeLog.splice(0, this.changeLog.length - KEEP_CHANGES);
        this.encoded = null;
    }
}

const indexes = new Map<string, ProviderIndex>();

export function libraryIndex(provider: string): ProviderIndex {
    let index = indexes.get(provider);
    if (!index) {
        index = ProviderIndex.forProvider(provider);
        indexes.set(provider, index);
    }
    return index;
}

// Started with the server, so the first request finds the index ready.
export function startLibraryIndexes(): void {
    for (const provider of config.getAllProviders()) {
        void libraryIndex(provider).start().catch(error => logger.warn(`[list-index] ${provider}: start failed`, { error }));
    }
}
