// file-host: a file-sharing site that is not live. Files are prepared media
// from the cache (the mezzanine, or a lower rung as another copy).
//
// - Pages: /f/<id> (a file page with a download button), /a/<album> (album
//   listings, paged, for a browser extension), /thumb/<id>.svg.
// - API: GET /api/file/<id> (metadata), POST /api/link {id} (a signed,
//   short-lived download URL on the download host, another port).
// - The download button (/download/<id>) redirects to a fresh signed URL;
//   the download host may redirect back and forth between the two hosts
//   (`redirectHops`) before it serves bytes, so a client's allow-list is
//   checked on every hop. An `offsiteRedirect` fault points a hop at a host
//   nobody should follow.
// - Downloads: byte ranges with an ETag and If-Range; an expired or forged
//   signature is 403; `transferStall` faults throttle, stall or cut bodies;
//   `etagChange` changes the validator (a resume must start over).
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileStream, planRange, sha256File, type TransferShape } from "../http/files.js";
import { html, HttpError, json, Router, text, type Reply, type RequestContext } from "../http/server.js";
import { hashHex, intBetween } from "../rng.js";
import type { FileHostFault, FileHostSpec, HostedFile } from "../scenario/hosts.js";
import type { Simulation, SiteModule } from "../sim.js";
import { escapeHtml, HostFaults, humanBytes } from "./host-faults.js";
import { mac } from "./tokens.js";

const SITE = "file-host" as const;
export const FILE_HOST_CDN = "file-host-cdn";
const HASHES = "file-host-hashes";

interface Resolved {
    file: HostedFile;
    path: string;
    size: number;
    mtimeMs: number;
    source: string;
    from: string;
}

type HashCache = Record<string, { size: number; mtimeMs: number; sha256: string }>;

export class FileHostSite implements SiteModule {
    readonly id = SITE;
    readonly router = new Router();
    readonly cdnRouter = new Router();
    readonly extraServers = [{ name: FILE_HOST_CDN, router: this.cdnRouter }];
    private hashing: Promise<void> = Promise.resolve();

    constructor(private readonly sim: Simulation, private readonly scheme: "http" | "https" = "http") {
        const r = this.router;
        r.get("/", ctx => this.home(ctx));
        r.get("/a/:album", ctx => this.album(ctx));
        r.get("/f/:id", ctx => this.page(ctx));
        r.get("/thumb/:name", ctx => this.thumb(ctx));
        r.get("/api/file/:id", ctx => this.fileApi(ctx));
        r.post("/api/link", ctx => this.link(ctx));
        r.get("/download/:id", ctx => this.downloadButton(ctx));
        r.get("/dl/:id/:name", ctx => this.download(ctx));
        this.cdnRouter.get("/dl/:id/:name", ctx => this.download(ctx));
    }

    // ---------- scenario ----------

    private spec(): FileHostSpec {
        const spec = this.sim.engine.scenario.sites[SITE];
        if (!spec) throw new HttpError(404, "file-host is not part of the current scenario");
        return spec;
    }

    private faults(): HostFaults<FileHostFault> {
        return new HostFaults(SITE, this.sim.engine.seed, this.sim.engine.epochMs, this.spec().faults);
    }

    private get secret(): string { return hashHex(this.sim.engine.seed, SITE, "signing"); }

    private resolve(file: HostedFile): Resolved {
        const sources = this.sim.library.ids();
        const source = file.source ?? sources[intBetween(0, sources.length - 1, this.sim.engine.seed, SITE, file.id, "source")];
        if (!this.sim.library.sources.has(source)) throw new Error(`file-host file ${file.id}: media source "${source}" is not in the cache`);
        const from = file.from ?? "mezzanine";
        const rel = from === "mezzanine" ? join("work-mezzanine", "mezzanine.mp4") : join(`work-${from}`, "rung.mp4");
        const path = join(this.sim.library.root, source, rel);
        if (!existsSync(path)) throw new Error(`file-host file ${file.id}: ${source}/${rel} does not exist (from: "${from}")`);
        const st = statSync(path);
        return { file, path, size: st.size, mtimeMs: Math.floor(st.mtimeMs), source, from };
    }

    /** The file if it is up at `t` (appeared, not removed). */
    private visible(id: string, t: number): Resolved | null {
        const spec = this.spec();
        const file = spec.files.find(f => f.id === id);
        if (!file || this.sim.engine.epochMs + (file.at ?? 0) * 1000 > t) return null;
        if (this.faults().happened("fileRemoved", t, f => f.file === id).length > 0) return null;
        return this.resolve(file);
    }

    private etag(r: Resolved, t: number): string {
        const generation = this.faults().happened("etagChange", t, f => f.file === undefined || f.file === r.file.id).length;
        return `"${hashHex(r.path, r.size, r.mtimeMs).slice(0, 16)}-${generation}"`;
    }

    onLoad(t: number): void {
        const spec = this.sim.engine.scenario.sites[SITE];
        if (!spec) return;
        const resolved = spec.files.map(f => this.resolve(f)); // missing media fails the load
        // Hash every file once (cached across restarts) and log what each id serves.
        this.hashing = this.hashing.then(async () => {
            const cache = this.sim.store.read<HashCache>(HASHES, {});
            for (const r of resolved) {
                let entry = cache[r.path];
                if (!entry || entry.size !== r.size || entry.mtimeMs !== r.mtimeMs) {
                    entry = { size: r.size, mtimeMs: r.mtimeMs, sha256: await sha256File(r.path) };
                    cache[r.path] = entry;
                    this.sim.store.write(HASHES, cache);
                }
                this.sim.truth.append({
                    type: "event", t, site: SITE, event: "file", file: r.file.id, name: r.file.name, album: r.file.album ?? null,
                    source: r.source, from: r.from, bytes: r.size, sha256: entry.sha256,
                    availableFrom: this.sim.engine.epochMs + (r.file.at ?? 0) * 1000,
                });
            }
        }).catch(error => {
            this.sim.truth.append({ type: "event", t, site: SITE, event: "file-hash-failed", reason: String((error as Error)?.message ?? error) });
        });
    }

    /** Resolves once every file of the current scenario is hashed and logged. */
    whenHashed(): Promise<void> { return this.hashing; }

    describe(t: number): Record<string, unknown> | null {
        const spec = this.sim.engine.scenario.sites[SITE];
        if (!spec) return null;
        return {
            cdn: this.sim.urls[FILE_HOST_CDN] ?? null,
            files: spec.files.map(f => ({ id: f.id, name: f.name, album: f.album ?? null, up: this.visible(f.id, t) !== null })),
            albums: spec.albums.map(a => a.id),
        };
    }

    // ---------- faults ----------

    private apiFault(api: "page" | "file" | "link" | "album" | "download", t: number, kind: string): Reply | null {
        const f = this.faults().active("apiStatus", t, x => x.api === undefined || x.api === api)[0];
        if (!f) return null;
        if (f.status === "reset") return { status: "reset", kind };
        if (f.status === "malformed") {
            return api === "page" || api === "album"
                ? html(200, "<!doctype html><title>Just a moment</title><p>Checking your browser.</p>", { kind })
                : json(200, { ok: false }, { kind });
        }
        return text(f.status, `error ${f.status}`, "text/plain; charset=utf-8", { kind });
    }

    // ---------- URLs ----------

    private origin(ctx: RequestContext): string {
        return `${this.scheme}://${ctx.req.headers.host ?? "127.0.0.1"}`;
    }

    private hostBase(name: string): string {
        const base = this.sim.urls[name];
        if (!base) throw new HttpError(503, "download host is not listening");
        const hostname = this.spec().cdnHostname;
        if (!hostname || name !== FILE_HOST_CDN) return base;
        const url = new URL(base);
        url.hostname = hostname;
        return url.origin;
    }

    private signature(id: string, name: string, exp: number): string {
        return mac(this.secret, "download", id, name, exp);
    }

    /** A signed URL on the download host, valid `signatureTtlS` from `t`. */
    signedUrl(file: HostedFile, t: number, hop = 0): { url: string; expires: number } {
        const exp = Math.floor(t / 1000) + (this.spec().signatureTtlS ?? 60);
        return { url: this.hopUrl(file.id, file.name, exp, this.signature(file.id, file.name, exp), hop), expires: exp };
    }

    private hopUrl(id: string, name: string, exp: number, sig: string, hop: number): string {
        // Even hops on the download host, odd ones back on the site's host.
        const base = this.hostBase(hop % 2 === 0 ? FILE_HOST_CDN : SITE);
        const q = new URLSearchParams({ exp: String(exp), sig });
        if (hop > 0) q.set("hop", String(hop));
        return `${base}/dl/${encodeURIComponent(id)}/${encodeURIComponent(name)}?${q}`;
    }

    // ---------- pages ----------

    private layout(title: string, body: string, head = ""): string {
        return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${head}
<style>body{font-family:sans-serif;margin:2rem;max-width:60rem}#gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr));gap:1rem}.item img{width:100%}</style>
</head><body><header><a href="/" class="site-name">File host</a></header>${body}</body></html>`;
    }

    private visibleFiles(t: number, album?: string): Resolved[] {
        return this.spec().files
            .filter(f => album === undefined || f.album === album)
            .map(f => this.visible(f.id, t))
            .filter((r): r is Resolved => r !== null)
            .sort((a, b) => (a.file.at ?? 0) - (b.file.at ?? 0) || a.file.id.localeCompare(b.file.id));
    }

    private card(r: Resolved): string {
        const date = new Date(this.sim.engine.epochMs + (r.file.at ?? 0) * 1000).toISOString().slice(0, 10);
        return `<div class="item" data-file-id="${escapeHtml(r.file.id)}"><a href="/f/${encodeURIComponent(r.file.id)}"><img class="thumb" src="/thumb/${encodeURIComponent(r.file.id)}.svg" alt=""></a>
<p class="name">${escapeHtml(r.file.name)}</p><p class="size" data-bytes="${r.size}">${humanBytes(r.size)}</p><p class="date">${date}</p></div>`;
    }

    private home(ctx: RequestContext): Reply {
        const fault = this.apiFault("page", ctx.now, "page");
        if (fault) return fault;
        const spec = this.spec();
        const albums = spec.albums.map(a => `<li><a class="album" href="/a/${encodeURIComponent(a.id)}">${escapeHtml(a.title)}</a></li>`).join("");
        return html(200, this.layout("File host", `<h1>Files</h1><ul class="albums">${albums}</ul>
<div id="gallery">${this.visibleFiles(ctx.now).map(r => this.card(r)).join("\n")}</div>`));
    }

    private album(ctx: RequestContext): Reply {
        const fault = this.apiFault("album", ctx.now, "page");
        if (fault) return fault;
        const spec = this.spec();
        const album = spec.albums.find(a => a.id === ctx.params.album);
        if (!album) return html(404, this.layout("Not found", "<h1>Album not found</h1>"), { log: { reason: "no such album" } });
        const pageSize = spec.albumPageSize ?? 24;
        const files = this.visibleFiles(ctx.now, album.id);
        const pages = Math.max(1, Math.ceil(files.length / pageSize));
        const page = Number(ctx.url.searchParams.get("page") ?? "1");
        if (!Number.isInteger(page) || page < 1 || page > pages) return html(404, this.layout("Not found", "<h1>No such page</h1>"), { log: { reason: "past the last page" } });
        const shown = files.slice((page - 1) * pageSize, page * pageSize);
        const nav = [
            page > 1 ? `<a rel="prev" href="/a/${encodeURIComponent(album.id)}?page=${page - 1}">Previous</a>` : "",
            page < pages ? `<a rel="next" href="/a/${encodeURIComponent(album.id)}?page=${page + 1}">Next</a>` : "",
        ].join(" ");
        return html(200, this.layout(album.title, `<h1 class="album-title">${escapeHtml(album.title)}</h1>
<p class="album-meta"><span class="count" data-count="${files.length}">${files.length} files</span> <span class="page" data-page="${page}" data-pages="${pages}">page ${page} of ${pages}</span></p>
<div id="gallery">${shown.map(r => this.card(r)).join("\n")}</div>
<nav class="pagination">${nav}</nav>`));
    }

    private page(ctx: RequestContext): Reply {
        const fault = this.apiFault("page", ctx.now, "page");
        if (fault) return fault;
        const r = this.visible(ctx.params.id, ctx.now);
        if (!r) return html(404, this.layout("Not found", "<h1>File not found</h1>"), { log: { file: ctx.params.id, reason: "no such file" } });
        const id = encodeURIComponent(r.file.id);
        const context = JSON.stringify({ id: r.file.id, name: r.file.name, size: r.size, api: `/api/file/${id}`, link: "/api/link" }).replace(/</g, "\\u003c");
        return html(200, this.layout(r.file.name, `<h1 class="file-name">${escapeHtml(r.file.name)}</h1>
<p class="file-size" data-bytes="${r.size}">${humanBytes(r.size)}</p>
<video id="player" controls preload="none" poster="/thumb/${id}.svg" data-poster="/thumb/${id}.svg"></video>
<p><a id="download" class="download-button" href="/download/${id}" data-file-id="${escapeHtml(r.file.id)}">Download</a></p>
${r.file.album ? `<p>Album: <a class="album" href="/a/${encodeURIComponent(r.file.album)}">${escapeHtml(r.file.album)}</a></p>` : ""}
<script>window.fileContext = ${context};</script>`, `<meta property="og:image" content="/thumb/${id}.svg"><meta property="og:title" content="${escapeHtml(r.file.name)}">`),
        { log: { file: r.file.id } });
    }

    private thumb(ctx: RequestContext): Reply {
        const id = ctx.params.name.replace(/\.svg$/, "");
        const r = this.visible(id, ctx.now);
        if (!r) return text(404, "not found", "text/plain; charset=utf-8", { kind: "page" });
        const hue = parseInt(hashHex(r.file.id).slice(0, 2), 16) * 360 / 256;
        return text(200, `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="hsl(${hue.toFixed(0)},45%,40%)"/><text x="160" y="96" font-family="sans-serif" font-size="16" fill="#fff" text-anchor="middle">${escapeHtml(r.file.name.slice(0, 32))}</text></svg>`,
            "image/svg+xml", { kind: "page" });
    }

    // ---------- API ----------

    private fileApi(ctx: RequestContext): Reply {
        const fault = this.apiFault("file", ctx.now, "api");
        if (fault) return fault;
        const r = this.visible(ctx.params.id, ctx.now);
        if (!r) return json(404, { error: "not found" }, { kind: "api", log: { file: ctx.params.id } });
        return json(200, {
            id: r.file.id, name: r.file.name, size: r.size, type: "video/mp4", album: r.file.album ?? null,
            page: `${this.origin(ctx)}/f/${encodeURIComponent(r.file.id)}`,
            uploadedAt: new Date(this.sim.engine.epochMs + (r.file.at ?? 0) * 1000).toISOString(),
        }, { kind: "api", log: { file: r.file.id } });
    }

    private async link(ctx: RequestContext): Promise<Reply> {
        const fault = this.apiFault("link", ctx.now, "api");
        if (fault) return fault;
        const spec = this.spec();
        if (spec.requireReferer) {
            const referer = ctx.req.headers.referer ?? "";
            if (!referer.startsWith(`${this.origin(ctx)}/f/`)) return json(403, { error: "missing referer" }, { kind: "api", log: { reason: "referer" } });
        }
        let id: string | undefined;
        try { id = (await ctx.fields()).id; } catch { /* checked below */ }
        if (!id) return json(400, { error: "id is required" }, { kind: "api" });
        const r = this.visible(id, ctx.now);
        if (!r) return json(404, { error: "not found" }, { kind: "api", log: { file: id } });
        const { url, expires } = this.signedUrl(r.file, ctx.now);
        this.sim.truth.append({ type: "event", t: ctx.now, site: SITE, event: "link-issued", file: r.file.id, expires: expires * 1000 });
        return json(200, { url, expires, ttlS: spec.signatureTtlS ?? 60, name: r.file.name, size: r.size }, { kind: "api", log: { file: r.file.id } });
    }

    private downloadButton(ctx: RequestContext): Reply {
        const fault = this.apiFault("download", ctx.now, "redirect");
        if (fault) return fault;
        const r = this.visible(ctx.params.id, ctx.now);
        if (!r) return html(404, this.layout("Not found", "<h1>File not found</h1>"), { kind: "redirect", log: { file: ctx.params.id } });
        const { url } = this.signedUrl(r.file, ctx.now);
        return { status: 302, kind: "redirect", headers: { location: url }, log: { file: r.file.id } };
    }

    // ---------- download host ----------

    private download(ctx: RequestContext): Reply {
        const t = ctx.now;
        const fault = this.apiFault("download", t, "download");
        if (fault) return fault;
        const { id, name } = ctx.params;
        const q = ctx.url.searchParams;
        const exp = Number(q.get("exp"));
        const sig = q.get("sig") ?? "";
        const hop = Number(q.get("hop") ?? "0");
        const log = { file: id };
        if (!Number.isInteger(exp) || sig !== this.signature(id, name, exp)) {
            return text(403, "Invalid signature", "text/plain; charset=utf-8", { kind: "download", log: { ...log, reason: "signature" } });
        }
        if (exp * 1000 <= t) return text(403, "Link expired", "text/plain; charset=utf-8", { kind: "download", log: { ...log, reason: "expired" } });
        const r = this.visible(id, t);
        if (!r) return text(404, "File not found", "text/plain; charset=utf-8", { kind: "download", log: { ...log, reason: "no such file" } });
        const spec = this.spec();
        const hops = spec.redirectHops ?? 0;
        if (hop < hops) {
            const offsite = this.faults().active("offsiteRedirect", t)[0];
            const location = offsite ? offsite.url : this.hopUrl(id, name, exp, sig, hop + 1);
            return { status: 302, kind: "redirect", headers: { location }, log: { ...log, reason: offsite ? "offsite" : `hop ${hop + 1}` } };
        }
        if (hop === 0 && hops === 0) {
            const offsite = this.faults().active("offsiteRedirect", t)[0];
            if (offsite) return { status: 302, kind: "redirect", headers: { location: offsite.url }, log: { ...log, reason: "offsite" } };
        }

        const etag = this.etag(r, t);
        const lastModified = new Date(this.sim.engine.epochMs + (r.file.at ?? 0) * 1000).toUTCString();
        const plan = planRange(r.size, { range: header(ctx, "range"), ifRange: header(ctx, "if-range") }, { etag, lastModified });
        const headers = {
            ...plan.headers, "content-type": "video/mp4",
            "content-disposition": `attachment; filename="${r.file.name.replace(/["\\\r\n]/g, "_")}"`,
            "cache-control": "private, max-age=0",
        };
        const range = plan.status === 206 ? `${plan.start}-${plan.end}` : undefined;
        if (plan.status === 416) return { status: 416, kind: "download", headers, log: { ...log, reason: "range not satisfiable" } };
        const stall = this.faults().active("transferStall", t, f => f.file === undefined || f.file === id)[0];
        const shape: TransferShape | undefined = stall
            ? { mode: stall.mode, afterBytes: stall.afterBytes, bytesPerSecond: stall.bytesPerSecond, stallMs: stall.stallS !== undefined ? stall.stallS * 1000 : undefined }
            : undefined;
        return {
            status: plan.status, kind: "download", headers,
            stream: fileStream(r.path, plan.start, plan.end, shape),
            log: { ...log, ...(range ? { range } : {}), ...(stall ? { reason: stall.mode } : {}) },
        };
    }
}

function header(ctx: RequestContext, name: string): string | undefined {
    const v = ctx.req.headers[name];
    return Array.isArray(v) ? v[0] : v;
}
