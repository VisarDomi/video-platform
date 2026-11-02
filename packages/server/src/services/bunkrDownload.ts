import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mp4Identity, MP4RenameError, type MP4Rename } from "./video/mp4Identity.js";
import { originalVideoName } from "./video/originalVideo.js";

const DOMAINS = new Set(["bunkr.si", "bunkr.ph", "bunkr.cr"]);
export function bunkrPage(value: unknown): URL {
    const url = new URL(typeof value === "string" ? value : "");
    if (url.protocol !== "https:" || !DOMAINS.has(url.hostname) || url.port || url.username || url.password ||
        !/^\/f\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) throw new Error("Expected a bunkr.si, .ph or .cr /f/ video URL");
    url.search = ""; url.hash = ""; url.pathname = url.pathname.replace(/\/$/, "");
    return url;
}
function allowedURL(value: string): URL {
    const url = new URL(value);
    const allowed = DOMAINS.has(url.hostname) || /^dl\.bunkr\.(si|ph|cr)$/.test(url.hostname) ||
        /^[a-z0-9-]+\.cdn\.cr$/.test(url.hostname);
    if (url.protocol !== "https:" || url.port || url.username || url.password || !allowed) throw new Error("Unsupported Bunkr download host");
    return url;
}
type Fetcher = typeof fetch;
async function request(fetcher: Fetcher, value: string, init: RequestInit = {}, media = false): Promise<Response> {
    let url = allowedURL(value);
    for (let redirects = 0; redirects < 6; redirects++) {
        const response = await fetcher(url, { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(30_000) });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            url = allowedURL(new URL(response.headers.get("location") ?? "", url).href);
            continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Bunkr HTTP ${response.status}`); }
        if (!media && Number(response.headers.get("content-length")) > 1_048_576) {
            await response.body?.cancel(); throw new Error("Bunkr metadata too large");
        }
        return response;
    }
    throw new Error("Too many Bunkr redirects");
}
async function smallText(response: Response): Promise<string> {
    const reader = response.body!.getReader(); let size = 0; const chunks: Buffer[] = [];
    try {
        while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.length;
            if (size > 1_048_576) throw new Error("Bunkr metadata too large");
            chunks.push(Buffer.from(part.value));
        }
        return Buffer.concat(chunks).toString("utf8");
    } finally { await reader.cancel(); }
}
export async function resolveBunkr(page: string, fetcher: Fetcher = fetch): Promise<{ url: string; filename: string }> {
    const source = bunkrPage(page);
    const html = await smallText(await request(fetcher, source.href));
    const link = html.match(/href=["'](https:\/\/dl\.bunkr\.(?:si|ph|cr)\/file\/\d+)["']/i)?.[1];
    if (!link) throw new Error("Bunkr video download button not found");
    const download = allowedURL(link);
    const id = download.pathname.split("/").at(-1)!;
    const meta = JSON.parse(await smallText(await request(fetcher, `${download.origin}/api/_001_v2`, {
        method: "POST", headers: { "Content-Type": "application/json", Referer: download.href }, body: JSON.stringify({ id }),
    }))) as { mediafiles?: string; path?: string; original?: string };
    if (typeof meta.mediafiles !== "string" || typeof meta.path !== "string" || typeof meta.original !== "string") throw new Error("Invalid Bunkr metadata");
    const raw = allowedURL(meta.mediafiles + meta.path);
    const filename = meta.original.replace(/[\x00-\x1f\x7f/\\:]/g, "_").replace(/^\.+/, "_").slice(0, 180);
    if (!originalVideoName(filename)) throw new Error("Bunkr file is not a video");
    const signed = JSON.parse(await smallText(await request(fetcher,
        `https://glb-apisign.cdn.cr/sign?path=${encodeURIComponent(decodeURIComponent(raw.pathname))}`))) as { token?: string; ex?: number | string };
    if (typeof signed.token !== "string" || !signed.token || !/^\d+$/.test(String(signed.ex))) throw new Error("Invalid Bunkr signature");
    raw.searchParams.set("n", meta.original); raw.searchParams.set("token", signed.token); raw.searchParams.set("ex", String(signed.ex));
    return { url: raw.href, filename };
}

export interface BunkrJob {
    id: string; page: string; state: "queued" | "downloading" | "complete" | "failed";
    createdAt: string; updatedAt: string; attempts: number; bytes: number;
    filename?: string; total?: number; etag?: string; error?: string; retryAt?: number; durableBytes?: number;
    fileId?: string; originalFilename?: string;
}
interface Options { directory?: string; stateDirectory?: string; fetcher?: Fetcher; autoStart?: boolean }
// One byte-copy transfer, outside the conversion/upload campaign. Jobs and partials survive service restarts.
export class BunkrDownloads {
    readonly directory: string;
    private stateDirectory: string;
    private fetcher: Fetcher;
    private jobs = new Map<string, BunkrJob>();
    private admissions = new Map<string, Promise<BunkrJob>>();
    private writes = new Map<string, Promise<void>>();
    private ready: Promise<void>;
    private running = false;
    private stopped = false;
    private controller?: AbortController;
    private timer?: NodeJS.Timeout;
    private autoStart: boolean;
    constructor(options: Options = {}) {
        this.directory = options.directory ?? path.join(os.homedir(), "Videos/plab/bunkr");
        this.stateDirectory = options.stateDirectory ?? path.join(os.homedir(), ".local/share/video-services/bunkr-downloads");
        this.fetcher = options.fetcher ?? fetch; this.autoStart = options.autoStart !== false;
        this.ready = this.load();
        void this.ready.then(() => this.kick()).catch(error => console.error("Bunkr queue could not open:", error.message));
    }
    private async load() {
        await mkdir(this.stateDirectory, { recursive: true });
        const parent = await open(path.dirname(this.stateDirectory), "r"); try { await parent.sync(); } finally { await parent.close(); }
        for (const name of await readdir(this.stateDirectory)) {
            if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
            const job = JSON.parse(await readFile(path.join(this.stateDirectory, name), "utf8")) as BunkrJob;
            bunkrPage(job.page);
            if (`${job.id}.json` !== name || (job.filename && path.basename(job.filename) !== job.filename)) throw new Error("Invalid saved Bunkr job");
            if (job.state === "downloading") job.state = "queued";
            this.jobs.set(job.id, job);
        }
        this.jobs = new Map([...this.jobs].sort(([aId, a], [bId, b]) => a.createdAt.localeCompare(b.createdAt) || aId.localeCompare(bId)));
    }
    private async save(job: BunkrJob) {
        job.updatedAt = new Date().toISOString();
        const snapshot = JSON.stringify(job) + "\n";
        const previous = this.writes.get(job.id) ?? Promise.resolve();
        const write = previous.catch(() => undefined).then(() => this.writeJob(job.id, snapshot));
        this.writes.set(job.id, write);
        try { await write; }
        finally { if (this.writes.get(job.id) === write) this.writes.delete(job.id); }
    }
    private async writeJob(id: string, snapshot: string) {
        const file = path.join(this.stateDirectory, `${id}.json`);
        await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
        const handle = await open(`${file}.tmp`, "r"); try { await handle.sync(); } finally { await handle.close(); }
        await rename(`${file}.tmp`, file);
        const directory = await open(this.stateDirectory, "r"); try { await directory.sync(); } finally { await directory.close(); }
    }
    private async syncDirectory() {
        const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
    }
    private async publish(partial: string, destination: string) {
        const handle = await open(partial, "r"); try { await handle.sync(); } finally { await handle.close(); }
        // link never overwrites a file created by the user while the download was running.
        await link(partial, destination); await this.syncDirectory();
        await unlink(partial); await this.syncDirectory();
    }
    private async publishedIdentity(job: BunkrJob, destination: string) {
        const file = await stat(destination).catch(() => undefined);
        // Publication already succeeded. A user's subsequent removal is not a failed
        // transfer and must never make the queue restore that completed download.
        if (file) job.fileId = mp4Identity(file);
    }
    async enqueue(value: unknown): Promise<BunkrJob> {
        await this.ready;
        const page = bunkrPage(value);
        const id = createHash("sha256").update(page.pathname).digest("hex").slice(0, 24);
        const pending = this.admissions.get(id);
        if (pending) return { ...await pending };
        const existing = this.jobs.get(id);
        if (existing && existing.state !== "failed") return { ...existing };
        if ([...this.jobs.values()].filter(j => j.state !== "complete").length + this.admissions.size >= 100) throw new Error("Bunkr queue is full");
        const admission = this.admit(existing ? { ...existing, state: "queued", attempts: 0 } : {
            id, page: page.href, state: "queued", createdAt: new Date().toISOString(), updatedAt: "", attempts: 0, bytes: 0,
        });
        this.admissions.set(id, admission);
        try { return { ...await admission }; }
        finally { this.admissions.delete(id); }
    }
    private async admit(job: BunkrJob): Promise<BunkrJob> {
        delete job.error; delete job.retryAt;
        // The worker cannot see an input until its receipt is durable. Duplicate
        // requests share this promise instead of acknowledging an uncommitted map entry.
        await this.save(job);
        this.jobs.set(job.id, job); this.kick(); return job;
    }
    async get(id: string) { await this.ready; const job = this.jobs.get(id); return job ? { ...job } : undefined; }
    async prepareLocalRename(from: string, to: string, fileId: string, bytes: number): Promise<string[]> {
        await this.ready;
        const selected = [...this.jobs.values()].filter(job => job.fileId === fileId || (job.filename === from && !job.fileId));
        if (selected.some(job => job.state !== "complete")) throw new MP4RenameError(409, "The download is still being finalized");
        const ids = selected.filter(job => job.total === bytes).map(job => job.id);
        if ([...this.jobs.values()].some(job => job.filename === to && job.state !== "complete" && !ids.includes(job.id))) {
            throw new MP4RenameError(409, "Another download is using that filename");
        }
        for (const id of ids) {
            const job = this.jobs.get(id)!; job.originalFilename ??= job.filename ?? from; job.filename = from; job.fileId ??= fileId; await this.save(job);
        }
        return ids;
    }
    async commitLocalRename(change: MP4Rename): Promise<void> {
        await this.ready;
        for (const id of change.jobs) {
            const job = this.jobs.get(id);
            if (!job || job.state !== "complete" || job.total !== change.bytes || (job.fileId && job.fileId !== change.fileId)
                || (job.filename !== change.from && job.filename !== change.to)) throw new Error("Download association changed during rename");
            job.originalFilename ??= change.from; job.filename = change.to; job.fileId = change.fileId;
            await this.save(job);
        }
    }
    private kick() {
        if (!this.autoStart || this.running || this.stopped) return;
        this.running = true;
        void this.runPending().catch(error => console.error("Bunkr queue:", error.message)).finally(() => {
            this.running = false;
            if (!this.stopped) { this.timer = setTimeout(() => this.kick(), 5000); this.timer.unref(); }
        });
    }
    async runPending() {
        await this.ready;
        for (const job of this.jobs.values()) {
            if (this.stopped) break;
            if (job.state !== "queued" || (job.retryAt ?? 0) > Date.now()) continue;
            job.state = "downloading"; job.attempts++; delete job.error;
            try { await this.save(job); await this.transfer(job); job.state = "complete"; delete job.retryAt; }
            catch (error) {
                job.error = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[URL]") : "Bunkr download failed";
                job.state = job.attempts >= 5 ? "failed" : "queued";
                job.retryAt = Date.now() + Math.min(300_000, 15_000 * 2 ** (job.attempts - 1));
                if (this.stopped) { job.state = "queued"; job.attempts--; job.retryAt = 0; }
            }
            await this.save(job);
        }
    }
    private async transfer(job: BunkrJob) {
        const controller = new AbortController(); this.controller = controller;
        try { await this.transferBytes(job, controller); }
        finally { this.controller = undefined; }
    }
    private async transferBytes(job: BunkrJob, controller: AbortController) {
        const media = await resolveBunkr(job.page, (input, init) => this.fetcher(input, {
            ...init, signal: AbortSignal.any([controller.signal, init?.signal ?? AbortSignal.timeout(30_000)]),
        }));
        await mkdir(this.directory, { recursive: true });
        const parent = await open(path.dirname(this.directory), "r"); try { await parent.sync(); } finally { await parent.close(); }
        job.filename ??= `${job.page.split("/").at(-1)} - ${media.filename}`;
        job.originalFilename ??= job.filename;
        const destination = path.join(this.directory, job.filename), partial = `${destination}.part`;
        const existing = await stat(destination).catch(() => undefined);
        if (existing) {
            if (job.total && existing.size === job.total) {
                const alias = await stat(partial).catch(() => undefined);
                if (alias && alias.ino === existing.ino && alias.dev === existing.dev) { await unlink(partial); await this.syncDirectory(); }
                job.bytes = existing.size; job.fileId = mp4Identity(existing); return;
            }
            throw new Error("Destination exists with unexpected size; retained without overwriting");
        }
        let offset = (await stat(partial).catch(() => undefined))?.size ?? 0;
        const durable = job.durableBytes ?? 0;
        if (offset > durable) {
            // A power loss can leave an unflushed tail. Preserve those bytes separately before
            // returning to the fsynced checkpoint; never trust mere file length as coverage.
            const tail = `${partial}.retained-tail-${Date.now()}`;
            await pipeline(createReadStream(partial, { start: durable }), createWriteStream(tail, { flags: "wx" }));
            const saved = await open(tail, "r"); try { await saved.sync(); } finally { await saved.close(); }
            await this.syncDirectory();
            const handle = await open(partial, "r+"); try { await handle.truncate(durable); await handle.sync(); } finally { await handle.close(); }
            offset = durable;
        } else if (offset < durable) {
            if (offset) { await rename(partial, `${partial}.retained-short-${Date.now()}`); await this.syncDirectory(); }
            offset = 0; job.durableBytes = 0;
        }
        if (!offset) await unlink(partial).catch(error => { if (error.code !== "ENOENT") throw error; });
        if (offset && offset === job.total && job.etag) {
            const head = await request(this.fetcher, media.url, { method: "HEAD" }, true);
            await head.body?.cancel();
            if (head.headers.get("etag") === job.etag && Number(head.headers.get("content-length")) === offset) {
                await this.publish(partial, destination); job.bytes = offset; await this.publishedIdentity(job, destination); return;
            }
        }
        // An idle read is bounded separately; a large, progressing video has no 30-second total deadline.
        let idle = setTimeout(() => controller.abort(), 60_000);
        const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), 60_000); };
        try {
            const headers: Record<string, string> = { "Accept-Encoding": "identity", Referer: job.page };
            if (offset && job.etag) { headers.Range = `bytes=${offset}-`; headers["If-Range"] = job.etag; }
            const response = await request(this.fetcher, media.url, { headers, signal: controller.signal }, true);
            const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
            const resume = response.status === 206;
            if (/text\/html|application\/json/.test(response.headers.get("content-type") ?? "")) {
                await response.body?.cancel(); throw new Error("Bunkr returned a page instead of video bytes");
            }
            if (resume && (!headers.Range || !range || Number(range[1]) !== offset || response.headers.get("etag") !== job.etag)) {
                await response.body?.cancel(); throw new Error("Bunkr returned an inconsistent resume range");
            }
            if (!resume && offset) {
                // Keep the previous nonempty bytes if the CDN cannot establish identical resume coverage.
                await rename(partial, `${partial}.retained-${Date.now()}`);
                await this.syncDirectory();
            }
            const length = Number(response.headers.get("content-length"));
            if (!(length > 0)) { await response.body?.cancel(); throw new Error("Bunkr returned no video length"); }
            job.total = resume ? Number(range![3]) : length;
            job.etag = response.headers.get("etag") ?? undefined; job.bytes = resume ? offset : 0; job.durableBytes = job.bytes;
            await this.save(job);
            const handle = await open(partial, resume ? "a" : "wx");
            await this.syncDirectory();
            let checkpointAt = Date.now();
            try {
                for await (const chunk of Readable.fromWeb(response.body! as never)) {
                    touch(); await handle.writeFile(chunk); job.bytes += chunk.length;
                    if (job.bytes - (job.durableBytes ?? 0) >= 8 * 1024 * 1024 || Date.now() - checkpointAt >= 5000) {
                        await handle.datasync(); job.durableBytes = job.bytes; await this.save(job); checkpointAt = Date.now();
                    }
                }
            } finally {
                try { await handle.datasync(); job.durableBytes = job.bytes; await this.save(job); }
                finally { await handle.close(); }
            }
            if ((await stat(partial)).size !== job.total) throw new Error("Bunkr download length mismatch");
            await this.publish(partial, destination);
            await this.publishedIdentity(job, destination);
        } finally { clearTimeout(idle); }
    }
    stop() { this.stopped = true; clearTimeout(this.timer); this.controller?.abort(); }
}
