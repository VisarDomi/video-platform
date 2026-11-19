// form-host: a browser-driven upload destination. Its pages carry the DOM a
// browser automation works against, and its own scripts post every form:
//
// - Sign-in: a consent wall (#overlay, #okButton), a login form at /login/
//   (one visible form: `username`, a password input named `pass`, a CSRF token,
//   a styled-hidden remember-me box; hidden reset-password inputs to ignore),
//   "Hello, <name>" once signed in. One session per account: a password login
//   signs every other session out. The session cookie rotates on page views
//   once it is old (the old id works for a grace period), a remember-me cookie
//   starts a new session, and scenario `logout` events sign accounts out.
// - Session evidence at GET /upload-video/: signed in = 200 with
//   `name="content"`; signed out = a redirect to /login/ (or /), or a 200 with
//   `name="pass"`. Cache windows answer from a shared cache with `age` and
//   `x-cache-status: HIT` (a verdict from such a page is inconclusive).
// - Uploads: chunks (<= 4 MiB, multipart `content` + `index`) to
//   /upload-video/?mode=async&action=upload_file, retried at the same index;
//   a media-free finish_upload assembles them. The video exists only once the
//   metadata form (title, description, tags, category checkboxes) is posted.
// - /my/videos/: public/private tabs with totals, a lagging "My Videos (N)",
//   30 rows a page through an async block URL, 404 past the last page.
// - /edit-video/<id>/: 404 while processing and after removal; the published
//   anchor is the slug URL /video/<id>/<slug>/. The slugless /video/<id>/ is
//   404. Tiers by source width (full HD only from 1920 wide), served from
//   /get_file/ with ranges.
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileStream, planRange } from "../http/files.js";
import { html, HttpError, json, Router, setCookie, type Reply, type RequestContext } from "../http/server.js";
import { hashHex, intBetween } from "../rng.js";
import type { FormHostFault, FormHostSpec } from "../scenario/hosts.js";
import type { Simulation, SiteModule } from "../sim.js";
import { escapeHtml, HostFaults, sleep } from "./host-faults.js";
import { mac } from "./tokens.js";
import { containsWord, MediaStore, qualityTiers, replaceWords, slugify, stateAt, timeline, type MediaFacts, type StoredVideo, type TimelineSpec } from "./videos.js";

const SITE = "form-host" as const;
const STATE = "form-host-state";
const MAX_CHUNK = 4 * 1024 * 1024;
const LIST_BLOCK = "list_videos_my_uploaded_videos";

export const FORM_HOST_CATEGORIES = [
    { id: 21, name: "Matches" }, { id: 22, name: "Highlights" }, { id: 23, name: "Training" }, { id: 24, name: "Interviews" },
];

interface Session {
    account: string;
    /** When the chain of sessions this one belongs to began (a login). */
    loginAt: number;
    createdAt: number;
    via: "password" | "remember" | "rotation";
    supersededAt: number | null;
    revokedAt: number | null;
}

interface RememberToken { account: string; issuedAt: number; revokedAt: number | null }

interface Upload {
    account: string;
    createdAt: number;
    chunks: Record<string, { bytes: number; at: number }>;
    assembled: { file: string; bytes: number; sha256: string; facts: MediaFacts | null; at: number } | null;
    video: string | null;
}

interface State {
    secret: string;
    counter: number;
    nextId: number;
    sessions: Record<string, Session>;
    remember: Record<string, RememberToken>;
    uploads: Record<string, Upload>;
    videos: Record<string, StoredVideo>;
    created: Record<string, number>;
}

interface Auth {
    account: string | null;
    sid: string | null;
    session: Session | null;
    cookies: string[];
}

interface CacheEntry { at: number; reply: Reply }

export class FormHostSite implements SiteModule {
    readonly id = SITE;
    readonly router = new Router();
    private media: MediaStore | null = null;
    private readonly cache = new Map<string, CacheEntry>();

    constructor(private readonly sim: Simulation, private readonly scheme: "http" | "https" = "http") {
        const r = this.router;
        const page = (h: (ctx: RequestContext) => Promise<Reply> | Reply) => (ctx: RequestContext) => this.guard(ctx, h, true);
        const plain = (h: (ctx: RequestContext) => Promise<Reply> | Reply) => (ctx: RequestContext) => this.guard(ctx, h, false);
        r.get("/", page(ctx => this.home(ctx)));
        r.post("/consent/", plain(ctx => this.consent(ctx)));
        r.get("/login/", page(ctx => this.loginPage(ctx)));
        r.post("/login/", plain(ctx => this.login(ctx)));
        r.get("/logout/", plain(ctx => this.logout(ctx)));
        r.get("/upload-video/", page(ctx => this.uploadPage(ctx)));
        r.post("/upload-video/", plain(ctx => this.uploadPost(ctx)), { maxBodyBytes: MAX_CHUNK + 1024 * 1024 });
        r.get("/my/", plain(() => ({ status: 302, kind: "page", headers: { location: "/my/videos/" } })));
        r.get("/my/videos/", page(ctx => this.myVideos(ctx)));
        r.get("/edit-video/:id/", page(ctx => this.editPage(ctx)));
        r.get("/video/:id/:slug/", page(ctx => this.videoPage(ctx)));
        r.get("/video/:id/", plain(ctx => this.notFound(ctx, "slugless video URL")));
        r.get("/get_file/:id/:height/:name/", plain(ctx => this.getFile(ctx)));
    }

    // ---------- scenario and state ----------

    private spec(): FormHostSpec {
        const spec = this.sim.engine.scenario.sites[SITE];
        if (!spec) throw new HttpError(404, "form-host is not part of the current scenario");
        return spec;
    }

    private faults(): HostFaults<FormHostFault> {
        return new HostFaults(SITE, this.sim.engine.seed, this.sim.engine.epochMs, this.spec().faults);
    }

    private timelineSpec(): TimelineSpec {
        const spec = this.spec();
        return { epochMs: this.sim.engine.epochMs, processingS: spec.processingS ?? 60, processingRules: spec.processingRules, removals: spec.removals };
    }

    private state(): State {
        const existing = this.sim.store.read<State | null>(STATE, null);
        if (existing) return existing;
        const seed = this.sim.engine.seed;
        const fresh: State = {
            secret: hashHex(seed, SITE, "secret"), counter: 0, nextId: intBetween(100000, 900000, seed, SITE, "first-id"),
            sessions: {}, remember: {}, uploads: {}, videos: {}, created: {},
        };
        this.sim.store.write(STATE, fresh);
        return fresh;
    }

    private save(state: State): void { this.sim.store.write(STATE, state); }

    private mediaStore(): MediaStore {
        this.media ??= new MediaStore(this.sim.store, SITE);
        return this.media;
    }

    private event(t: number, event: string, fields: Record<string, unknown> = {}): void {
        this.sim.truth.append({ type: "event", t, site: SITE, event, ...fields });
    }

    private origin(ctx: RequestContext): string {
        return `${this.scheme}://${ctx.req.headers.host ?? "127.0.0.1"}`;
    }

    close(): void { this.media?.close(); }

    // ---------- request guard: outages and the shared cache ----------

    private async guard(ctx: RequestContext, handler: (ctx: RequestContext) => Promise<Reply> | Reply, cacheable: boolean): Promise<Reply> {
        const t = ctx.now;
        const path = ctx.url.pathname;
        const outage = this.faults().active("pageStatus", t, f => f.path === undefined || path.startsWith(f.path))[0];
        if (outage) {
            if (outage.status === "reset") return { status: "reset", kind: "page", log: { reason: "pageStatus" } };
            return html(outage.status, `<!doctype html><title>Error ${outage.status}</title><h1>Temporarily unavailable</h1>`, { log: { reason: "pageStatus" } });
        }
        const window = cacheable && ctx.req.method === "GET" ? this.faults().active("cacheWindow", t, f => path.startsWith(f.path))[0] : undefined;
        if (!window) return handler(ctx);
        const key = path + ctx.url.search;
        const hit = this.cache.get(key);
        const windowStart = this.faults().startMs(window);
        if (hit && hit.at >= windowStart && hit.at <= t) {
            // A shared cache: the page someone else got, without their cookies.
            const headers = { ...(hit.reply.headers ?? {}) };
            delete headers["set-cookie"];
            return {
                ...hit.reply, headers: { ...headers, age: String(Math.floor((t - hit.at) / 1000)), "x-cache-status": "HIT", "cache-control": "public, max-age=600" },
                log: { ...(hit.reply.log ?? {}), reason: "cache hit" },
            };
        }
        const reply = await handler(ctx);
        if (typeof reply.status === "number" && reply.status < 500) this.cache.set(key, { at: t, reply });
        return { ...reply, headers: { ...(reply.headers ?? {}), age: "0", "x-cache-status": "MISS", "cache-control": "public, max-age=600" } };
    }

    // ---------- sessions ----------

    private forcedOutAt(account: string, since: number, t: number, remember: boolean): number | null {
        const hit = this.faults().happened("logout", t, f => (f.account === undefined || f.account === account) && (!remember || f.revokeRemember))
            .map(f => this.faults().startMs(f)).filter(at => at > since);
        return hit.length ? hit[0] : null;
    }

    private sessionValid(s: Session | undefined, t: number): s is Session {
        if (!s || s.revokedAt !== null) return false;
        if (s.supersededAt !== null && t >= s.supersededAt + (this.spec().rotationGraceS ?? 30) * 1000) return false;
        return this.forcedOutAt(s.account, s.loginAt, t, false) === null;
    }

    private newSid(): string { return randomBytes(16).toString("hex"); }

    private sessionCookie(sid: string): string {
        return setCookie("sid", sid, { httpOnly: true });
    }

    /** Signs every session of the account out (one session per account). */
    private endSessions(state: State, account: string, t: number): void {
        for (const s of Object.values(state.sessions)) if (s.account === account && s.revokedAt === null) s.revokedAt = t;
    }

    private auth(ctx: RequestContext, options: { rotate?: boolean } = {}): Auth {
        const t = ctx.now;
        const state = this.state();
        const sid = ctx.cookies["sid"] ?? null;
        const session = sid ? state.sessions[sid] : undefined;
        if (sid && this.sessionValid(session, t)) {
            const rotateAfter = (this.spec().rotateSessionS ?? 600) * 1000;
            if (options.rotate && session.supersededAt === null && t - session.createdAt >= rotateAfter) {
                const next = this.newSid();
                state.sessions[next] = { account: session.account, loginAt: session.loginAt, createdAt: t, via: "rotation", supersededAt: null, revokedAt: null };
                session.supersededAt = t;
                this.save(state); // durable before the client sees the new id
                this.event(t, "session-rotated", { account: session.account });
                return { account: session.account, sid: next, session: state.sessions[next], cookies: [this.sessionCookie(next)] };
            }
            return { account: session.account, sid, session, cookies: [] };
        }
        // A remember-me cookie starts a new session and signs the others out.
        const token = ctx.cookies["remember"];
        const remembered = token ? state.remember[token] : undefined;
        if (remembered && remembered.revokedAt === null && this.forcedOutAt(remembered.account, remembered.issuedAt, t, true) === null
            && this.spec().accounts.some(a => a.username === remembered.account)) {
            this.endSessions(state, remembered.account, t);
            const next = this.newSid();
            state.sessions[next] = { account: remembered.account, loginAt: t, createdAt: t, via: "remember", supersededAt: null, revokedAt: null };
            this.save(state);
            this.event(t, "login", { account: remembered.account, via: "remember" });
            return { account: remembered.account, sid: next, session: state.sessions[next], cookies: [this.sessionCookie(next)] };
        }
        // A guest: a fresh id (not stored) that carries the login form's CSRF token.
        if (sid && !session && /^[0-9a-f]{32}$/.test(sid)) return { account: null, sid, session: null, cookies: [] };
        const guest = this.newSid();
        return { account: null, sid: guest, session: null, cookies: [this.sessionCookie(guest)] };
    }

    private csrf(sid: string | null): string {
        return mac(this.state().secret, "csrf", sid ?? "");
    }

    private displayName(account: string): string {
        return this.spec().accounts.find(a => a.username === account)?.displayName ?? account;
    }

    // ---------- layout ----------

    private layout(ctx: RequestContext, auth: Auth, title: string, body: string, status = 200, log: Reply["log"] = {}): Reply {
        const consented = ctx.cookies["consent"] === "1";
        const back = escapeHtml(ctx.url.pathname + ctx.url.search);
        const overlay = consented ? "" : `<div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10;display:flex;align-items:center;justify-content:center">
<form method="post" action="/consent/" class="consent-box" style="background:#fff;padding:2rem;max-width:30rem">
<p>This site stores cookies and shows full-length match recordings. Please confirm to continue.</p>
<input type="hidden" name="back" value="${back}"><button type="submit" id="okButton">Accept and continue</button></form></div>`;
        const user = auth.account
            ? `<a class="user-link" href="/my/videos/">Hello, ${escapeHtml(this.displayName(auth.account))}</a> <a class="logout-link" href="/logout/">Log out</a>`
            : `<a class="login-link" href="/login/">Log in</a>`;
        return html(status, `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:sans-serif;margin:0}header{padding:1rem;background:#234;color:#fff}header a{color:#fff;margin-right:1rem}main{padding:1rem 2rem;max-width:70rem}
.item{border-bottom:1px solid #ddd;padding:.5rem 0}.generic-error{color:#b00}.notice{background:#ffd;padding:.5rem}.categories-popup{border:1px solid #888;padding:.5rem}</style>
</head><body>${overlay}<header><a href="/" class="site-name">Form host</a> <a href="/upload-video/">Upload</a> ${user}</header><main>${body}</main></body></html>`,
        { headers: auth.cookies.length ? { "set-cookie": auth.cookies } : {}, log });
    }

    private notFound(ctx: RequestContext, reason: string): Reply {
        return this.layout(ctx, { account: null, sid: null, session: null, cookies: [] }, "Not found", "<h1>404</h1><p>The page you requested was not found.</p>", 404, { reason });
    }

    private home(ctx: RequestContext): Reply {
        const auth = this.auth(ctx, { rotate: true });
        return this.layout(ctx, auth, "Form host", `<h1>Tennis uploads</h1><p>Share full matches and highlights.</p>`);
    }

    private async consent(ctx: RequestContext): Promise<Reply> {
        const back = (await ctx.form()).get("back") ?? "/";
        return {
            status: 303, kind: "page",
            headers: { location: back.startsWith("/") && !back.startsWith("//") ? back : "/", "set-cookie": setCookie("consent", "1", { maxAgeS: 7 * 86400 }) },
        };
    }

    // ---------- login ----------

    private loginForm(auth: Auth, error = ""): string {
        return `<h1>Log in</h1><div class="login-block">
<form id="login_form" method="post" action="/login/" class="form-login">
<input type="hidden" name="action" value="login"><input type="hidden" name="csrf_token" value="${this.csrf(auth.sid)}">
${error ? `<div class="generic-error">${escapeHtml(error)}</div>` : ""}
<label for="login_username">Username or email</label><input type="text" name="username" id="login_username" autocomplete="username">
<label for="login_pass">Password</label><input type="password" name="pass" id="login_pass" autocomplete="current-password">
<span class="remember" style="position:absolute;left:-9999px"><input type="checkbox" name="remember_me" value="1" id="login_remember_me"><label for="login_remember_me">Remember me</label></span>
<button type="submit" class="submit">Log in</button>
</form>
<form id="reset_password_form" method="post" action="/login/" style="display:none">
<input type="hidden" name="action" value="reset"><input type="text" name="email" autocomplete="email"><input type="password" name="pass_new"><input type="password" name="pass_confirm"><button type="submit">Reset</button>
</form></div>`;
    }

    private loginPage(ctx: RequestContext): Reply {
        const auth = this.auth(ctx);
        if (auth.account) return { status: 302, kind: "page", headers: withCookies(auth, { location: "/" }) };
        return this.layout(ctx, auth, "Log in", this.loginForm(auth));
    }

    private async login(ctx: RequestContext): Promise<Reply> {
        const t = ctx.now;
        const form = await ctx.form();
        const auth = this.auth(ctx);
        if ((form.get("csrf_token") ?? "") !== this.csrf(auth.sid)) {
            return this.layout(ctx, auth, "Log in", `<p class="generic-error">Invalid security token, please try again.</p>${this.loginForm(auth)}`, 403, { reason: "csrf" });
        }
        const username = form.get("username") ?? "";
        const account = this.spec().accounts.find(a => a.username === username && a.password === (form.get("pass") ?? ""));
        if (!account) {
            this.event(t, "login-failed", { username });
            return this.layout(ctx, auth, "Log in", this.loginForm(auth, "Wrong username or password."), 200, { reason: "bad credentials" });
        }
        const state = this.state();
        this.endSessions(state, account.username, t);
        const sid = this.newSid();
        state.sessions[sid] = { account: account.username, loginAt: t, createdAt: t, via: "password", supersededAt: null, revokedAt: null };
        const cookies = [this.sessionCookie(sid)];
        if (form.get("remember_me") === "1") {
            const token = randomBytes(20).toString("hex");
            state.remember[token] = { account: account.username, issuedAt: t, revokedAt: null };
            cookies.push(setCookie("remember", token, { maxAgeS: 30 * 86400, httpOnly: true }));
        }
        this.save(state);
        this.event(t, "login", { account: account.username, via: "password", remember: form.get("remember_me") === "1" });
        return { status: 302, kind: "auth", headers: { location: "/", "set-cookie": cookies } };
    }

    private logout(ctx: RequestContext): Reply {
        const sid = ctx.cookies["sid"];
        const state = this.state();
        if (sid && state.sessions[sid]) {
            state.sessions[sid].revokedAt = ctx.now;
            const token = ctx.cookies["remember"];
            if (token && state.remember[token]) state.remember[token].revokedAt = ctx.now;
            this.save(state);
            this.event(ctx.now, "logout", { account: state.sessions[sid].account });
        }
        return { status: 302, kind: "auth", headers: { location: "/", "set-cookie": [setCookie("sid", "", { maxAgeS: 0 }), setCookie("remember", "", { maxAgeS: 0 })] } };
    }

    // ---------- upload ----------

    private signedOut(ctx: RequestContext, auth: Auth, async: boolean): Reply {
        const style = this.spec().signedOutUpload ?? "redirect-login";
        const headers: Record<string, string | string[]> = auth.cookies.length ? { "set-cookie": auth.cookies } : {};
        if (async || style === "redirect-login") return { status: 302, kind: "page", headers: { ...headers, location: "/login/" }, log: { reason: "signed out" } };
        if (style === "redirect-home") return { status: 302, kind: "page", headers: { ...headers, location: "/" }, log: { reason: "signed out" } };
        return this.layout(ctx, auth, "Log in", this.loginForm(auth), 200, { reason: "signed out" });
    }

    private uploadToken(account: string): string {
        const rand = randomBytes(12).toString("hex");
        return `${rand}.${mac(this.state().secret, "upload", account, rand)}`;
    }

    private checkUploadToken(token: string, account: string): string | null {
        const [rand, sig] = token.split(".");
        return rand && sig === mac(this.state().secret, "upload", account, rand) ? rand : null;
    }

    private categories() { return this.spec().categories ?? FORM_HOST_CATEGORIES; }

    private uploadPage(ctx: RequestContext, metaState?: { fileToken: string; values: URLSearchParams; error: string }): Reply {
        const auth = this.auth(ctx, { rotate: !metaState });
        if (!auth.account) return this.signedOut(ctx, auth, false);
        const spec = this.spec();
        const chunk = spec.chunkSize ?? MAX_CHUNK;
        const v = (k: string) => escapeHtml(metaState?.values.get(k) ?? "");
        const chosen = new Set(metaState?.values.getAll("category_ids[]") ?? []);
        const cats = this.categories().map(c => `<input type="checkbox" id="category_${c.id}" value="${c.id}" style="display:none"${chosen.has(String(c.id)) ? " checked" : ""}><label for="category_${c.id}">${escapeHtml(c.name)}</label>`).join("\n");
        const hidden = [...chosen].map(id => `<input type="hidden" name="category_ids[]" value="${escapeHtml(id)}">`).join("");
        const context = JSON.stringify({ upload_chunk_size: chunk, upload_url: "/upload-video/?mode=async&action=upload_file", finish_url: "/upload-video/?mode=async&action=finish_upload" });
        return this.layout(ctx, auth, "Upload video", `<h1>Upload video</h1>
<div class="form-upload"${metaState ? ' style="display:none"' : ""}>
<form id="upload_form" method="post" action="/upload-video/" enctype="multipart/form-data">
<input type="hidden" name="upload_token" value="${this.uploadToken(auth.account)}">
<label><input type="radio" name="upload_option" id="edit_video_upload_option_file" value="file" checked> Upload a file</label>
<input type="file" name="content" accept="video/*">
<button type="submit" class="submit">Upload</button>
<div class="progressbar"><div class="bar" style="width:0%;height:4px;background:#2a6"></div><span class="text">0%</span></div>
<div class="generic-error" style="display:none"></div>
</form></div>
<form id="edit_video_form" method="post" action="/upload-video/"${metaState ? "" : ' style="display:none"'}>
<input type="hidden" name="action" value="add_video"><input type="hidden" name="csrf_token" value="${this.csrf(auth.sid)}">
<input type="hidden" name="file_token" value="${escapeHtml(metaState?.fileToken ?? "")}">
${metaState?.error ? `<div class="generic-error">${escapeHtml(metaState.error)}</div>` : ""}
<p class="section-title">Title</p><input type="text" id="edit_video_title" name="title" maxlength="${spec.titleMax ?? 300}" value="${v("title")}">
<p class="section-title">Description</p><textarea id="edit_video_description" name="description">${v("description")}</textarea>
<p class="section-title">Tags</p><input type="text" id="edit_video_tags" name="tags" value="${v("tags")}" placeholder="comma, separated">
<p class="section-title">Categories</p><div id="edit_video_categories" class="categories-select" tabindex="0">${chosen.size ? `${chosen.size} selected` : "Choose categories"}</div>
<div class="categories-popup" style="display:none">${cats}</div><div class="selected-categories">${hidden}</div>
<p class="section-title">Visibility</p><label><input type="radio" name="is_private" value="0"${metaState?.values.get("is_private") === "1" ? "" : " checked"}> Public</label>
<label><input type="radio" name="is_private" value="1"${metaState?.values.get("is_private") === "1" ? " checked" : ""}> Private</label>
<p><button type="submit" class="submit" id="edit_video_submit">Save</button></p>
</form>
<script>window.pageContext = ${context};</script>
<script>${UPLOAD_SCRIPT}</script>`);
    }

    private async uploadPost(ctx: RequestContext): Promise<Reply> {
        const q = ctx.url.searchParams;
        if (q.get("mode") === "async") {
            if (q.get("action") === "upload_file") return this.chunk(ctx);
            if (q.get("action") === "finish_upload") return this.finish(ctx);
            return json(400, { status: "failure", errors: [{ code: "unknown_action" }] }, { kind: "api" });
        }
        return this.addVideo(ctx);
    }

    private async chunk(ctx: RequestContext): Promise<Reply> {
        const t = ctx.now;
        const auth = this.auth(ctx);
        if (!auth.account) return this.signedOut(ctx, auth, true);
        let part;
        try { part = await ctx.multipart(); } catch (error) {
            if (error instanceof HttpError && error.status === 413) return json(413, { status: "failure", errors: [{ code: "chunk_too_large", message: "chunk too large" }] }, { kind: "upload" });
            throw error;
        }
        const index = Number(part.fields.get("index"));
        const content = part.files.get("content");
        const rand = this.checkUploadToken(part.fields.get("upload_token") ?? "", auth.account);
        if (!rand) return json(400, { status: "failure", errors: [{ code: "invalid_token", message: "upload expired, reload the page" }] }, { kind: "upload" });
        if (!Number.isInteger(index) || index < 0 || !content) return json(400, { status: "failure", errors: [{ code: "bad_chunk", message: "missing content or index" }] }, { kind: "upload" });
        if (content.data.length > MAX_CHUNK) return json(413, { status: "failure", errors: [{ code: "chunk_too_large", message: "chunk too large" }] }, { kind: "upload" });
        const log = { reason: `chunk ${index}` };
        const fault = this.faults().active("chunkFault", t, f => f.index === undefined || f.index === index)[0];
        if (fault) {
            switch (fault.mode) {
                case "drop": return { status: "reset", kind: "upload", log: { reason: `chunk ${index} dropped` } };
                case "stall": await sleep((fault.stallS ?? 90) * 1000); return { status: "reset", kind: "upload", log: { reason: `chunk ${index} stalled` } };
                case "login-redirect": return { status: 302, kind: "upload", headers: { location: "/login/" }, log: { reason: `chunk ${index} login redirect` } };
                case "non-json": return html(200, "<!doctype html><title>Please wait</title><p>Service temporarily unavailable.</p>", { kind: "upload", log: { reason: `chunk ${index} non-json` } });
                case "status": return json(fault.status ?? 503, { status: "failure", errors: [{ code: "server_error" }] }, { kind: "upload", log: { reason: `chunk ${index} status` } });
            }
        }
        const state = this.state();
        const upload = state.uploads[rand] ??= { account: auth.account, createdAt: t, chunks: {}, assembled: null, video: null };
        if (upload.assembled) return json(409, { status: "failure", errors: [{ code: "already_finished" }] }, { kind: "upload", log });
        this.mediaStore().put(join("parts", rand, String(index)), content.data);
        const retry = upload.chunks[String(index)] !== undefined;
        upload.chunks[String(index)] = { bytes: content.data.length, at: t };
        this.save(state);
        this.event(t, "chunk", { upload: rand, index, bytes: content.data.length, retry });
        return json(200, { status: "success", index, received: content.data.length }, { kind: "upload", log });
    }

    private async finish(ctx: RequestContext): Promise<Reply> {
        const t = ctx.now;
        const auth = this.auth(ctx);
        if (!auth.account) return this.signedOut(ctx, auth, true);
        const fields = await ctx.form();
        const rand = this.checkUploadToken(fields.get("upload_token") ?? "", auth.account);
        const state = this.state();
        const upload = rand ? state.uploads[rand] : undefined;
        if (!rand || !upload) return json(400, { status: "failure", errors: [{ code: "invalid_token", message: "nothing uploaded" }] }, { kind: "upload" });
        const delay = this.spec().assemblyDelayMs ?? 0;
        if (delay > 0) await sleep(delay);
        if (!upload.assembled) {
            const total = Number(fields.get("total"));
            const declared = Number(fields.get("filesize"));
            if (!Number.isInteger(total) || total < 1) return json(400, { status: "failure", errors: [{ code: "bad_total" }] }, { kind: "upload" });
            const missing = Array.from({ length: total }, (_, i) => i).filter(i => !upload.chunks[String(i)]);
            if (missing.length) return json(400, { status: "failure", errors: [{ code: "missing_chunks", indexes: missing, message: "some chunks are missing" }] }, { kind: "upload" });
            const bytes = Array.from({ length: total }, (_, i) => upload.chunks[String(i)].bytes).reduce((a, b) => a + b, 0);
            if (Number.isFinite(declared) && declared > 0 && declared !== bytes) {
                return json(400, { status: "failure", errors: [{ code: "size_mismatch", expected: declared, received: bytes }] }, { kind: "upload" });
            }
            if (bytes > (this.spec().maxBytes ?? 10 * 1024 ** 3)) return json(400, { status: "failure", errors: [{ code: "file_too_large" }] }, { kind: "upload" });
            const store = this.mediaStore();
            const file = store.assemble(Array.from({ length: total }, (_, i) => store.path("parts", rand, String(i))), join("media", `${rand}.bin`));
            const { sha256, facts } = await store.facts(file);
            upload.assembled = { file, bytes, sha256, facts, at: t };
            this.save(state);
            store.remove(join("parts", rand));
            this.event(t, "upload-assembled", { upload: rand, bytes, sha256, facts });
        }
        return json(200, { status: "success", file_token: `${rand}.${mac(state.secret, "file", rand)}` }, { kind: "upload" });
    }

    private async addVideo(ctx: RequestContext): Promise<Reply> {
        const t = ctx.now;
        const form = await ctx.form();
        const auth = this.auth(ctx);
        if (!auth.account) return this.signedOut(ctx, auth, true);
        const again = (error: string, status = 200) => {
            const reply = this.uploadPage(ctx, { fileToken: form.get("file_token") ?? "", values: form, error });
            return { ...reply, status, log: { reason: error } };
        };
        if ((form.get("csrf_token") ?? "") !== this.csrf(auth.sid)) return again("Invalid security token, please try again.", 403);
        const state = this.state();
        const [rand, sig] = (form.get("file_token") ?? "").split(".");
        const upload = rand ? state.uploads[rand] : undefined;
        if (!upload || sig !== mac(state.secret, "file", rand) || upload.account !== auth.account || !upload.assembled) return again("Your upload has expired, please upload the file again.");
        if (upload.video) return again("This file was already submitted.");
        const spec = this.spec();
        const title = (form.get("title") ?? "").trim();
        const description = (form.get("description") ?? "").trim();
        const tags = (form.get("tags") ?? "").split(",").map(s => s.trim()).filter(Boolean);
        const categories = form.getAll("category_ids[]").filter(id => this.categories().some(c => String(c.id) === id));
        if (!title) return again("Please enter a title.");
        if (title.length > (spec.titleMax ?? 300)) return again(`The title is longer than ${spec.titleMax ?? 300} characters.`);
        if (categories.length === 0) return again("Please choose at least one category.");
        const everything = [title, description, ...tags].join("\n");
        const refused = spec.bannedWords.find(w => w.action === "refuse" && containsWord(everything, w.word));
        if (refused) {
            this.event(t, "metadata-refused", { account: auth.account, word: refused.word });
            return again(`Sorry, '${refused.word}' is not allowed here.`);
        }
        const replacing = spec.bannedWords.filter(w => w.action !== "refuse");
        const storedTitle = replaceWords(title, replacing);
        const storedDescription = replaceWords(description, replacing);
        const notices = replacing.filter(w => w.action === "replace-notice" && [...storedTitle.hits, ...storedDescription.hits].includes(w.word))
            .map(w => `Sorry, '${w.word}' is not allowed here.`);
        const limited = spec.visibilityRules.find(r => containsWord(everything, r.word));

        const id = String(state.nextId);
        state.counter++;
        state.nextId += 1 + intBetween(0, 4, this.sim.engine.seed, SITE, "id-step", state.counter);
        const nth = (state.created[auth.account] ?? 0) + 1;
        state.created[auth.account] = nth;
        const a = upload.assembled;
        const video: StoredVideo = {
            id, account: auth.account, nth, createdAt: t, title, description, tags, category: categories.join(","),
            visibility: form.get("is_private") === "1" ? "private" : "public",
            storedTitle: storedTitle.text, storedDescription: storedDescription.text, notices, limitedReason: limited?.reason ?? null,
            media: { file: a.file, bytes: a.bytes, sha256: a.sha256, facts: a.facts, at: t },
        };
        state.videos[id] = video;
        upload.video = id;
        this.save(state); // the creation boundary: durable before anyone hears of it
        const tl = timeline(video, this.timelineSpec());
        this.event(t, "video-created", {
            video: id, account: video.account, nth, title, storedTitle: video.storedTitle, visibility: video.visibility,
            bytes: a.bytes, sha256: a.sha256, facts: a.facts, slug: slugify(video.storedTitle),
            processedAt: tl.processedAt, outcome: tl.outcome, recoversAt: tl.recoversAt, removedAt: tl.removedAt,
            tiers: a.facts ? qualityTiers(a.facts).map(x => x.height) : [],
        });
        return this.layout(ctx, auth, "Upload complete", `<div class="upload-success"><h1>Thank you</h1><p>Your video was uploaded and is being processed.
It will appear in <a href="/my/videos/">My Videos</a>.</p></div>`, 200, { video: id });
    }

    // ---------- my videos ----------

    private ownVideos(account: string): StoredVideo[] {
        return Object.values(this.state().videos).filter(v => v.account === account)
            .sort((a, b) => b.createdAt - a.createdAt || Number(b.id) - Number(a.id));
    }

    private row(v: StoredVideo, t: number): string {
        const state = stateAt(v, this.timelineSpec(), t);
        const title = escapeHtml(v.storedTitle);
        const limited = v.limitedReason ? `<span class="line-limited">Limited visibility due to : ${escapeHtml(v.limitedReason)}</span>` : "";
        if (state === "processing") {
            return `<div class="item processing" data-item-id="${v.id}"><p class="inf"><a href="">${title}</a></p><span class="line-processing">Processing</span>${limited}</div>`;
        }
        if (state === "failed") return `<div class="item error" data-item-id="${v.id}"><p class="inf"><span class="title">${title}</span></p><span class="line-error">Error</span></div>`;
        return `<div class="item" data-item-id="${v.id}"><p class="inf"><a href="/video/${v.id}/${slugify(v.storedTitle)}/">${title}</a></p>${limited}<a class="edit" href="/edit-video/${v.id}/">Edit</a></div>`;
    }

    private myVideos(ctx: RequestContext): Reply {
        const t = ctx.now;
        const q = ctx.url.searchParams;
        const async = q.get("mode") === "async";
        const auth = this.auth(ctx, { rotate: !async });
        if (!auth.account) return { status: 302, kind: "page", headers: withCookies(auth, { location: "/login/" }), log: { reason: "signed out" } };
        if (async && (q.get("function") !== "get_block" || q.get("block_id") !== LIST_BLOCK)) return this.notFound(ctx, "unknown block");
        if (async) {
            const fault = this.faults().active("listStatus", t)[0];
            if (fault) return html(fault.status, `<!doctype html><title>${fault.status}</title>`, { log: { reason: "listStatus" } });
        }
        const spec = this.spec();
        const tl = this.timelineSpec();
        const isPrivate = q.get("is_private") === "1";
        const page = Number(q.get("from_my_videos") ?? "1");
        const all = this.ownVideos(auth.account);
        const listed = (at: number) => all.filter(v => v.createdAt <= at && stateAt(v, tl, at) !== "removed" && stateAt(v, tl, at) !== "rejected");
        const removalLag = (spec.removalLagS ?? 60) * 1000;
        const counted = all.filter(v => {
            const removedAt = timeline(v, tl).removedAt;
            return removedAt === null || t < removedAt + removalLag;
        });
        const totals = { public: counted.filter(v => v.visibility === "public").length, private: counted.filter(v => v.visibility === "private").length };
        const heading = listed(t - (spec.listTotalsLagS ?? 60) * 1000).length;
        const rows = listed(t).filter(v => (v.visibility === "private") === isPrivate);
        const pageSize = spec.pageSize ?? 30;
        const pages = Math.max(1, Math.ceil(rows.length / pageSize));
        if (!Number.isInteger(page) || page < 1 || page > pages) return this.notFound(ctx, "past the last page");
        const shown = rows.slice((page - 1) * pageSize, page * pageSize);
        const base = `/my/videos/?mode=async&function=get_block&block_id=${LIST_BLOCK}&sort_by=&is_private=${isPrivate ? 1 : 0}`;
        const pager = pages > 1 ? `<div class="pagination">${Array.from({ length: pages }, (_, i) => i + 1)
            .map(n => n === page ? `<span class="page-current">${n}</span>` : `<a class="page" data-page="${n}" href="${base}&from_my_videos=${n}">${n}</a>`).join(" ")}</div>` : "";
        const block = `<div id="${LIST_BLOCK}" data-page="${page}" data-pages="${pages}">
<div class="tabs"><a data-parameters="is_private:0" href="/my/videos/?is_private=0"${isPrivate ? "" : ' class="active"'}>Public (${totals.public})</a>
<a data-parameters="is_private:1" href="/my/videos/?is_private=1"${isPrivate ? ' class="active"' : ""}>Private (${totals.private})</a></div>
<div class="list-videos">${shown.map(v => this.row(v, t)).join("\n") || '<p class="empty">There are no videos in this list.</p>'}</div>
${pager}</div>`;
        const log = { reason: `page ${page}`, count: shown.length };
        if (async) return html(200, block, { log, headers: auth.cookies.length ? { "set-cookie": auth.cookies } : {} });
        return this.layout(ctx, auth, "My videos", `<h2>My Videos (${heading})</h2>${block}`, 200, log);
    }

    // ---------- edit, public page, files ----------

    private editPage(ctx: RequestContext): Reply {
        const t = ctx.now;
        const auth = this.auth(ctx, { rotate: true });
        if (!auth.account) return { status: 302, kind: "page", headers: withCookies(auth, { location: "/login/" }), log: { reason: "signed out" } };
        const v = this.state().videos[ctx.params.id];
        if (!v || v.account !== auth.account || stateAt(v, this.timelineSpec(), t) !== "ready") {
            return this.layout(ctx, auth, "Not found", "<h1>404</h1><p>The page you requested was not found.</p>", 404, { video: ctx.params.id, reason: v ? stateAt(v, this.timelineSpec(), t) : "no such video" });
        }
        const chosen = (v.category ?? "").split(",").filter(Boolean);
        const notices = [...v.notices, ...(v.limitedReason ? [`Limited visibility due to : ${v.limitedReason}`] : [])]
            .map(n => `<div class="notice">${escapeHtml(n)}</div>`).join("\n");
        const url = `${this.origin(ctx)}/video/${v.id}/${slugify(v.storedTitle)}/`;
        return this.layout(ctx, auth, `Edit: ${v.storedTitle}`, `<h1>Edit video</h1>${notices}
<p><a class="video-link" href="${url}">${escapeHtml(url)}</a></p>
<form id="edit_video_form" method="post" action="/edit-video/${v.id}/">
<p class="section-title">Title</p><input type="text" id="edit_video_title" name="title" value="${escapeHtml(v.storedTitle)}">
<p class="section-title">Description</p><textarea id="edit_video_description" name="description">${escapeHtml(v.storedDescription)}</textarea>
<p class="section-title">Tags</p><input type="text" id="edit_video_tags" name="tags" value="${escapeHtml(v.tags.join(", "))}">
<div class="selected-categories">${chosen.map(c => `<input type="hidden" name="category_ids[]" value="${escapeHtml(c)}">`).join("")}</div>
<p class="visibility" data-visibility="${v.visibility}">${v.visibility === "private" ? "Private" : "Public"}</p>
</form>`, 200, { video: v.id });
    }

    private videoPage(ctx: RequestContext): Reply {
        const t = ctx.now;
        const v = this.state().videos[ctx.params.id];
        if (!v || stateAt(v, this.timelineSpec(), t) !== "ready" || !v.media?.facts) return this.notFound(ctx, v ? stateAt(v, this.timelineSpec(), t) : "no such video");
        const slug = slugify(v.storedTitle);
        if (ctx.params.slug !== slug) return { status: 301, kind: "page", headers: { location: `/video/${v.id}/${slug}/` } };
        const auth = this.auth(ctx);
        const tiers = qualityTiers(v.media.facts).slice().reverse(); // lowest first, like the player config
        const fileUrl = (h: number) => `${this.origin(ctx)}/get_file/${v.id}/${h}/${v.id}_${h}p.mp4/`;
        const vars: Record<string, string> = { video_id: v.id, video_title: v.storedTitle };
        tiers.forEach((tier, i) => {
            const key = i === 0 ? "video_url" : i === 1 ? "video_alt_url" : `video_alt_url${i}`;
            vars[key] = fileUrl(tier.height);
            vars[`${key}_text`] = tier.label;
        });
        const downloads = tiers.map(tier => `<a class="download" href="${fileUrl(tier.height)}?download=true" data-height="${tier.height}">${tier.label}</a>`).join(" ");
        return this.layout(ctx, auth, v.storedTitle, `<h1 class="video-title">${escapeHtml(v.storedTitle)}</h1>
<div class="player"><video controls preload="none" src="${fileUrl(tiers.at(-1)!.height)}"></video></div>
<p class="downloads">${downloads}</p><div class="description">${escapeHtml(v.storedDescription)}</div>
<script>var flashvars = ${JSON.stringify(vars).replace(/</g, "\\u003c")};</script>`, 200, { video: v.id });
    }

    private async getFile(ctx: RequestContext): Promise<Reply> {
        const t = ctx.now;
        const v = this.state().videos[ctx.params.id];
        const height = Number(ctx.params.height);
        const log = { video: ctx.params.id, reason: `${height}p` };
        if (!v || stateAt(v, this.timelineSpec(), t) !== "ready" || !v.media?.facts) return html(404, "<!doctype html><h1>404</h1>", { kind: "media", log });
        const tier = qualityTiers(v.media.facts).find(x => x.height === height);
        if (!tier) return html(404, "<!doctype html><h1>404</h1>", { kind: "media", log });
        const fault = this.faults().active("tierStatus", t, f => f.height === height)[0];
        if (fault) return fault.status === "reset" ? { status: "reset", kind: "media", log } : html(fault.status, `<!doctype html><title>${fault.status}</title>`, { kind: "media", log });
        const file = await this.mediaStore().rendition(v, tier);
        const size = statSync(file).size;
        const plan = planRange(size, { range: ctx.req.headers.range, ifRange: header(ctx, "if-range") }, { etag: `"${v.media.sha256.slice(0, 16)}-${height}"` });
        if (plan.status === 416) return { status: 416, kind: "media", headers: plan.headers, log };
        return {
            status: plan.status, kind: "media", headers: { ...plan.headers, "content-type": "video/mp4" },
            stream: fileStream(file, plan.start, plan.end), log: { ...log, ...(plan.status === 206 ? { range: `${plan.start}-${plan.end}` } : {}) },
        };
    }

    // ---------- control API ----------

    describe(t: number): Record<string, unknown> | null {
        if (!this.sim.engine.scenario.sites[SITE]) return null;
        const tl = this.timelineSpec();
        const state = this.state();
        return {
            accounts: this.spec().accounts.map(a => ({
                username: a.username,
                signedIn: Object.values(state.sessions).some(s => s.account === a.username && this.sessionValid(s, t)),
            })),
            videos: Object.values(state.videos).map(v => ({ id: v.id, account: v.account, title: v.storedTitle, state: stateAt(v, tl, t), url: `/video/${v.id}/${slugify(v.storedTitle)}/` })),
        };
    }

    action(name: string, body: Record<string, unknown>, t: number): unknown {
        const state = this.state();
        if (name === "remove") {
            const v = state.videos[String(body.id)];
            if (!v) throw new RangeError(`no video ${String(body.id)}`);
            v.removedAt = t;
            v.removedBy = "control";
            v.removalReason = typeof body.reason === "string" ? body.reason : null;
            this.save(state);
            this.event(t, "video-removed", { video: v.id, by: "control", reason: v.removalReason });
            return { id: v.id, removedAt: t };
        }
        if (name === "logout") {
            const account = typeof body.account === "string" ? body.account : undefined;
            for (const s of Object.values(state.sessions)) if ((!account || s.account === account) && s.revokedAt === null) s.revokedAt = t;
            if (body.revokeRemember !== false) for (const r of Object.values(state.remember)) if ((!account || r.account === account) && r.revokedAt === null) r.revokedAt = t;
            this.save(state);
            this.event(t, "forced-logout", { account: account ?? null, by: "control" });
            return { ok: true };
        }
        if (name === "videos") return this.describe(t);
        throw new RangeError(`unknown action "${name}" (remove, logout, videos)`);
    }
}

function withCookies(auth: Auth, headers: Record<string, string>): Record<string, string | string[]> {
    return auth.cookies.length ? { ...headers, "set-cookie": auth.cookies } : headers;
}

function header(ctx: RequestContext, name: string): string | undefined {
    const v = ctx.req.headers[name];
    return Array.isArray(v) ? v[0] : v;
}

// The site's own uploader: chunks of pageContext.upload_chunk_size, up to
// three attempts per index, then the media-free finish request, then the
// metadata form. The category popup closes on any click outside it and
// turns ticked boxes into hidden category_ids[] inputs.
const UPLOAD_SCRIPT = `(function () {
  var form = document.getElementById('upload_form'), meta = document.getElementById('edit_video_form');
  var text = form.querySelector('.progressbar .text'), bar = form.querySelector('.progressbar .bar'), err = form.querySelector('.generic-error');
  function fail(m) { err.textContent = m; err.style.display = 'block'; }
  function post(url, data) {
    return fetch(url, { method: 'POST', body: data, credentials: 'same-origin', redirect: 'manual' }).then(function (r) {
      if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) throw new Error('signed out');
      return r.text().then(function (t) {
        var j; try { j = JSON.parse(t); } catch (e) { throw new Error('unexpected reply'); }
        if (j.status !== 'success') throw new Error((j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].code)) || 'upload failed');
        return j;
      });
    });
  }
  form.addEventListener('submit', async function (e) {
    e.preventDefault(); err.style.display = 'none';
    var file = form.querySelector('input[name=content]').files[0];
    if (!file) return fail('Choose a file first.');
    var size = window.pageContext.upload_chunk_size, total = Math.max(1, Math.ceil(file.size / size)), token = form.querySelector('[name=upload_token]').value;
    for (var i = 0; i < total; i++) {
      for (var attempt = 1; ; attempt++) {
        var fd = new FormData();
        fd.append('upload_token', token); fd.append('index', String(i)); fd.append('total', String(total)); fd.append('filename', file.name);
        fd.append('content', file.slice(i * size, Math.min(file.size, (i + 1) * size)), file.name);
        try { await post(window.pageContext.upload_url, fd); break; } catch (x) {
          if (x.message === 'signed out') return fail('Your session has expired, please log in again.');
          if (attempt >= 3) return fail('Upload failed, please try again.');
          await new Promise(function (r) { setTimeout(r, 1000 * attempt); });
        }
      }
      var pct = Math.floor((i + 1) * 100 / total); text.textContent = pct + '%'; bar.style.width = pct + '%';
    }
    var fin = new FormData();
    fin.append('upload_token', token); fin.append('total', String(total)); fin.append('filename', file.name); fin.append('filesize', String(file.size));
    var done; try { done = await post(window.pageContext.finish_url, fin); } catch (x) { return fail('Upload failed: ' + x.message); }
    meta.querySelector('[name=file_token]').value = done.file_token;
    form.parentNode.style.display = 'none'; meta.style.display = 'block';
    var title = meta.querySelector('#edit_video_title'); if (!title.value) title.value = file.name.replace(/\\.[^.]+$/, '');
  });
  var picker = document.getElementById('edit_video_categories'), popup = meta.querySelector('.categories-popup'), chosen = meta.querySelector('.selected-categories');
  picker.addEventListener('click', function (e) { e.stopPropagation(); popup.style.display = 'block'; });
  popup.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () {
    if (popup.style.display === 'none') return;
    popup.style.display = 'none'; chosen.innerHTML = '';
    popup.querySelectorAll('input[type=checkbox]').forEach(function (c) {
      if (!c.checked) return;
      var h = document.createElement('input'); h.type = 'hidden'; h.name = 'category_ids[]'; h.value = c.value; chosen.appendChild(h);
    });
    picker.textContent = chosen.children.length ? chosen.children.length + ' selected' : 'Choose categories';
  });
})();`;
