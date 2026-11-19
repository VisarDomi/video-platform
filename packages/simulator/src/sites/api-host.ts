// api-host: an API-style upload destination, no browser.
//
// - OAuth-like tokens: POST /oauth/token with grant_type=password (a new
//   token family) or refresh_token (a short-lived access token; with
//   `rotateRefreshTokens` the refresh token is single-use and a reused one
//   revokes its family). 401 `invalid_token` on the API = signed out;
//   `revokeTokens` events revoke every family created before them.
// - Resumable uploads: POST /upload/v1/videos?uploadType=resumable creates
//   the video (its id is known from here: creation boundary "api_create")
//   and an upload session (Location). PUT byte ranges with Content-Range;
//   308 "resume incomplete" with Range: bytes=0-<last>; `bytes */<total>`
//   asks for the offset; the final range answers 201 with the video (200
//   on a repeat). A clientRef (or Idempotency-Key) makes the create
//   idempotent, and GET /v1/videos?clientRef= finds the video after a crash.
// - Videos: status uploading/processing/ready/failed/rejected, renditions by
//   source width once ready; DELETE or a removal rule of kind "removed" makes
//   them 404; kind "rejected" keeps them with status rejected.
// - Quota: a daily unit budget (UTC day of the simulated clock); over it, 403
//   with reason quotaExceeded.
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileStream, planRange } from "../http/files.js";
import { html, HttpError, json, Router, type Reply, type RequestContext } from "../http/server.js";
import { hashHex } from "../rng.js";
import { DEFAULT_QUOTA_COSTS, type ApiHostFault, type ApiHostSpec, type QuotaOperation } from "../scenario/hosts.js";
import type { Simulation, SiteModule } from "../sim.js";
import { escapeHtml, HostFaults, sleep } from "./host-faults.js";
import { mac, signToken, verifyToken, type Claims } from "./tokens.js";
import { containsWord, MediaStore, qualityTiers, stateAt, timeline, type StoredVideo, type TimelineSpec, type VideoState } from "./videos.js";

const SITE = "api-host" as const;
const STATE = "api-host-state";
const MAX_PUT = 64 * 1024 * 1024;

interface Family {
    id: string;
    account: string;
    client: string;
    createdAt: number;
    generation: number;
    revokedAt: number | null;
}

interface UploadSession {
    id: string;
    video: string;
    account: string;
    total: number;
    contentType: string;
    createdAt: number;
    expiresAt: number;
    received: number;
    completedAt: number | null;
}

interface ApiVideo extends StoredVideo {
    session: string;
}

interface State {
    secret: string;
    counter: number;
    families: Record<string, Family>;
    sessions: Record<string, UploadSession>;
    videos: Record<string, ApiVideo>;
    created: Record<string, number>;
    quota: Record<string, number>;
}

interface AccessClaims extends Claims { typ: "access"; fam: string }

type ApiState = VideoState | "deleted";

const apiError = (code: number, reason: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, kind = "api"): Reply =>
    json(code, { error: { code, message, errors: [{ reason, message, ...extra }] } }, { kind, headers, log: { reason } });

export class ApiHostSite implements SiteModule {
    readonly id = SITE;
    readonly router = new Router();
    private media: MediaStore | null = null;

    constructor(private readonly sim: Simulation, private readonly scheme: "http" | "https" = "http") {
        const r = this.router;
        r.post("/oauth/token", ctx => this.token(ctx));
        r.post("/oauth/revoke", ctx => this.revoke(ctx));
        r.get("/oauth/tokeninfo", ctx => this.tokenInfo(ctx));
        r.get("/v1/me", ctx => this.api(ctx, "videos", "get", account => json(200, { id: account, username: account }, { kind: "api" })));
        r.get("/v1/limits", ctx => this.api(ctx, "videos", "limits", () => this.limits(ctx)));
        r.post("/upload/v1/videos", ctx => this.api(ctx, "upload", "insert", account => this.create(ctx, account)));
        r.put("/upload/v1/sessions/:session", ctx => this.api(ctx, "upload", "upload", account => this.put(ctx, account)), { maxBodyBytes: MAX_PUT });
        r.get("/v1/videos", ctx => this.api(ctx, "list", "list", account => this.list(ctx, account)));
        r.get("/v1/videos/:id", ctx => this.api(ctx, "videos", "get", account => this.get(ctx, account)));
        r.patch("/v1/videos/:id", ctx => this.api(ctx, "videos", "update", account => this.patch(ctx, account)));
        r.delete("/v1/videos/:id", ctx => this.api(ctx, "videos", "delete", account => this.remove(ctx, account)));
        r.get("/watch/:id", ctx => this.watch(ctx));
        r.get("/media/:id/:file", ctx => this.mediaFile(ctx));
    }

    // ---------- scenario and state ----------

    private spec(): ApiHostSpec {
        const spec = this.sim.engine.scenario.sites[SITE];
        if (!spec) throw new HttpError(404, "api-host is not part of the current scenario");
        return spec;
    }

    private faults(): HostFaults<ApiHostFault> {
        return new HostFaults(SITE, this.sim.engine.seed, this.sim.engine.epochMs, this.spec().faults);
    }

    private timelineSpec(): TimelineSpec {
        const spec = this.spec();
        return { epochMs: this.sim.engine.epochMs, processingS: spec.processingS ?? 60, processingRules: spec.processingRules, removals: spec.removals };
    }

    private state(): State {
        const existing = this.sim.store.read<State | null>(STATE, null);
        if (existing) return existing;
        const fresh: State = { secret: hashHex(this.sim.engine.seed, SITE, "secret"), counter: 0, families: {}, sessions: {}, videos: {}, created: {}, quota: {} };
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

    private apiFault(api: "token" | "videos" | "upload" | "list" | "media", t: number): Reply | null {
        const f = this.faults().active("apiStatus", t, x => x.api === undefined || x.api === api)[0];
        if (!f) return null;
        if (f.status === "reset") return { status: "reset", kind: "api", log: { reason: "apiStatus" } };
        return f.status === 429
            ? apiError(429, "rateLimitExceeded", "Too many requests", {}, { "retry-after": "30" })
            : apiError(f.status, "backendError", "The service is unavailable");
    }

    // ---------- tokens ----------

    private familyRevoked(f: Family, t: number): boolean {
        if (f.revokedAt !== null && f.revokedAt <= t) return true;
        return this.faults().happened("revokeTokens", t, x => x.account === undefined || x.account === f.account)
            .some(x => this.faults().startMs(x) > f.createdAt);
    }

    private refreshToken(state: State, f: Family): string {
        return `rt.${f.id}.${f.generation}.${mac(state.secret, "refresh", f.id, f.generation)}`;
    }

    private accessToken(state: State, f: Family, t: number): { token: string; expiresIn: number } {
        const ttl = this.spec().accessTokenTtlS ?? 3600;
        const iat = Math.floor(t / 1000);
        state.counter++;
        return { token: signToken(state.secret, { sub: f.account, fam: f.id, typ: "access", iat, exp: iat + ttl, n: state.counter }), expiresIn: ttl };
    }

    private async token(ctx: RequestContext): Promise<Reply> {
        const t = ctx.now;
        const fault = this.apiFault("token", t);
        if (fault) return fault;
        const fields = await ctx.fields();
        const basic = ctx.req.headers.authorization?.startsWith("Basic ") ? Buffer.from(ctx.req.headers.authorization.slice(6), "base64").toString().split(":") : [];
        const clientId = fields.client_id ?? basic[0] ?? "";
        const clientSecret = fields.client_secret ?? basic[1] ?? "";
        const spec = this.spec();
        if (!spec.clients.some(c => c.clientId === clientId && c.clientSecret === clientSecret)) {
            return json(401, { error: "invalid_client", error_description: "Unknown client or wrong secret." }, { kind: "auth", log: { reason: "invalid_client" } });
        }
        const state = this.state();
        const grant = fields.grant_type;
        if (grant === "password") {
            const account = spec.accounts.find(a => a.username === fields.username && a.password === fields.password);
            if (!account) {
                this.event(t, "login-failed", { username: fields.username ?? "" });
                return json(400, { error: "invalid_grant", error_description: "Wrong username or password." }, { kind: "auth", log: { reason: "invalid_grant" } });
            }
            state.counter++;
            const family: Family = { id: hashHex(state.secret, "family", state.counter).slice(0, 16), account: account.username, client: clientId, createdAt: t, generation: 1, revokedAt: null };
            state.families[family.id] = family;
            const access = this.accessToken(state, family, t);
            this.save(state); // durable before the client holds the token
            this.event(t, "login", { account: family.account, family: family.id });
            return json(200, { access_token: access.token, token_type: "Bearer", expires_in: access.expiresIn, refresh_token: this.refreshToken(state, family), scope: "videos" }, { kind: "auth", headers: { "cache-control": "no-store" } });
        }
        if (grant === "refresh_token") {
            const [prefix, familyId, generation, sig] = (fields.refresh_token ?? "").split(".");
            const family = state.families[familyId ?? ""];
            const refused = (why: string) => {
                this.event(t, "refresh-refused", { family: familyId ?? null, reason: why });
                return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }, { kind: "auth", log: { reason: why } });
            };
            if (prefix !== "rt" || !family || sig !== mac(state.secret, "refresh", familyId, Number(generation))) return refused("unknown");
            if (family.client !== clientId) return refused("client");
            if (this.familyRevoked(family, t)) return refused("revoked");
            if (spec.rotateRefreshTokens && Number(generation) !== family.generation) {
                family.revokedAt = t; // a reused refresh token: the family is compromised
                this.save(state);
                return refused("reused");
            }
            if (spec.rotateRefreshTokens) family.generation++;
            const access = this.accessToken(state, family, t);
            this.save(state);
            this.event(t, "refresh", { account: family.account, family: family.id, generation: family.generation });
            return json(200, {
                access_token: access.token, token_type: "Bearer", expires_in: access.expiresIn, scope: "videos",
                ...(spec.rotateRefreshTokens ? { refresh_token: this.refreshToken(state, family) } : {}),
            }, { kind: "auth", headers: { "cache-control": "no-store" } });
        }
        return json(400, { error: "unsupported_grant_type" }, { kind: "auth" });
    }

    private async revoke(ctx: RequestContext): Promise<Reply> {
        const token = (await ctx.fields()).token ?? "";
        const state = this.state();
        const familyId = token.startsWith("rt.") ? token.split(".")[1] : verifyToken<AccessClaims>(state.secret, token, ctx.now).claims?.fam;
        const family = familyId ? state.families[familyId] : undefined;
        if (family && family.revokedAt === null) {
            family.revokedAt = ctx.now;
            this.save(state);
            this.event(ctx.now, "revoked", { account: family.account, family: family.id });
        }
        return json(200, {}, { kind: "auth" });
    }

    /** The account behind a bearer token, or why there is none. */
    private bearer(token: string | undefined, t: number): { account: string; claims: AccessClaims } | { reason: "invalid_token" | "expired_token" | "revoked_token" } {
        const state = this.state();
        const v = verifyToken<AccessClaims>(state.secret, token, t);
        if (!v.ok) return { reason: v.reason === "expired" ? "expired_token" : "invalid_token" };
        if (v.claims.typ !== "access") return { reason: "invalid_token" };
        const family = state.families[v.claims.fam];
        if (!family || this.familyRevoked(family, t)) return { reason: "revoked_token" };
        return { account: family.account, claims: v.claims };
    }

    private tokenInfo(ctx: RequestContext): Reply {
        const who = this.bearer(ctx.url.searchParams.get("access_token") ?? undefined, ctx.now);
        if ("reason" in who) return json(400, { error: "invalid_token", error_description: who.reason }, { kind: "auth" });
        return json(200, { sub: who.account, exp: who.claims.exp, expires_in: Math.max(0, who.claims.exp - Math.floor(ctx.now / 1000)), scope: "videos" }, { kind: "auth" });
    }

    // ---------- the API wrapper: faults, auth, quota ----------

    private async api(ctx: RequestContext, api: "videos" | "upload" | "list", op: QuotaOperation, handler: (account: string) => Promise<Reply> | Reply): Promise<Reply> {
        const t = ctx.now;
        const fault = this.apiFault(api, t);
        if (fault) return fault;
        const header = ctx.req.headers.authorization ?? "";
        const who = this.bearer(header.startsWith("Bearer ") ? header.slice(7) : undefined, t);
        if ("reason" in who) {
            return apiError(401, who.reason, "Request had invalid authentication credentials.", {},
                { "www-authenticate": `Bearer realm="api-host", error="invalid_token", error_description="${who.reason}"` });
        }
        const quota = this.spec().quota;
        if (quota) {
            const cost = quota.costs?.[op] ?? DEFAULT_QUOTA_COSTS[op];
            const state = this.state();
            const day = new Date(t).toISOString().slice(0, 10);
            const used = state.quota[day] ?? 0;
            if (cost > 0 && used + cost > quota.dailyUnits) {
                this.event(t, "quota-exceeded", { account: who.account, op, used, cost, dailyUnits: quota.dailyUnits });
                return apiError(403, "quotaExceeded", `The request cannot be completed because the daily quota of ${quota.dailyUnits} units is used up.`, { domain: "usageLimits" });
            }
            if (cost > 0) {
                state.quota[day] = used + cost;
                this.save(state);
            }
        }
        return handler(who.account);
    }

    private limits(ctx: RequestContext): Reply {
        const spec = this.spec();
        const quota = spec.quota;
        const day = new Date(ctx.now).toISOString().slice(0, 10);
        return json(200, {
            maxBytes: spec.maxBytes ?? 128 * 1024 ** 3, minDurationS: spec.minDurationS ?? 0, maxDurationS: spec.maxDurationS ?? null,
            titleMax: spec.titleMax ?? 100, descriptionMax: spec.descriptionMax ?? 5000, tagsMax: spec.tagsMax ?? 30, chunkGranularity: 256 * 1024,
            quota: quota ? { dailyUnits: quota.dailyUnits, used: this.state().quota[day] ?? 0, resetsAt: `${new Date(Date.parse(day) + 86400_000).toISOString()}` } : null,
        }, { kind: "api" });
    }

    // ---------- videos ----------

    private videoState(v: ApiVideo, t: number): ApiState {
        if (!v.media) {
            const session = this.state().sessions[v.session];
            if (v.removedAt !== null && v.removedAt !== undefined && t >= v.removedAt) return "deleted";
            return session && t >= session.expiresAt ? "failed" : "uploading";
        }
        const s = stateAt(v, this.timelineSpec(), t);
        return s === "removed" ? "deleted" : s;
    }

    private resource(v: ApiVideo, t: number, ctx: RequestContext): Record<string, unknown> {
        const s = this.videoState(v, t);
        const tl = timeline(v, this.timelineSpec());
        const origin = this.origin(ctx);
        const facts = v.media?.facts ?? null;
        const session = this.state().sessions[v.session];
        return {
            kind: "video", id: v.id, clientRef: v.clientRef ?? null, createdAt: new Date(v.createdAt).toISOString(),
            snippet: { title: v.storedTitle, description: v.storedDescription, tags: v.tags, categoryId: v.category },
            status: {
                uploadStatus: s, privacyStatus: v.visibility,
                ...(s === "failed" ? { failureReason: v.failureReason ?? (v.media ? (facts ? "processingFailed" : "invalidFile") : "uploadExpired") } : {}),
                ...(s === "rejected" ? { rejectionReason: tl.removalReason ?? "policy" } : {}),
            },
            processingDetails: { processingStatus: s === "processing" ? "processing" : s === "ready" ? "succeeded" : s === "failed" ? "failed" : s === "uploading" ? "pending" : "terminated" },
            upload: session ? { received: session.received, total: session.total, complete: session.completedAt !== null } : null,
            fileDetails: v.media ? { bytes: v.media.bytes, sha256: v.media.sha256, ...(facts ?? {}) } : null,
            renditions: s === "ready" && facts ? qualityTiers(facts).map(x => ({ height: x.height, width: x.outWidth, label: x.label, url: `${origin}/media/${v.id}/${x.height}.mp4` })) : [],
            watchUrl: `${origin}/watch/${v.id}`,
        };
    }

    private findVideo(id: string, account: string, t: number): ApiVideo | null {
        const v = this.state().videos[id];
        if (!v || v.account !== account || this.videoState(v, t) === "deleted") return null;
        return v;
    }

    private notFound(id: string): Reply {
        return apiError(404, "videoNotFound", `Video ${id} was not found.`, {}, {}, "api");
    }

    private bannedIn(spec: ApiHostSpec, fields: Array<[string, string]>): Array<{ field: string; term: string }> {
        return fields.flatMap(([field, text]) => spec.bannedWords.filter(w => containsWord(text, w.word)).map(w => ({ field, term: w.word })));
    }

    private metadataProblem(spec: ApiHostSpec, snippet: { title?: unknown; description?: unknown; tags?: unknown }): Reply | null {
        const title = typeof snippet.title === "string" ? snippet.title : "";
        const description = typeof snippet.description === "string" ? snippet.description : "";
        const tags = Array.isArray(snippet.tags) ? snippet.tags.map(String) : [];
        if (!title.trim()) return apiError(400, "invalidTitle", "The title is required.");
        if (title.length > (spec.titleMax ?? 100)) return apiError(400, "invalidTitle", `The title is longer than ${spec.titleMax ?? 100} characters.`);
        if (description.length > (spec.descriptionMax ?? 5000)) return apiError(400, "invalidDescription", "The description is too long.");
        if (tags.length > (spec.tagsMax ?? 30)) return apiError(400, "invalidTags", "Too many tags.");
        const banned = this.bannedIn(spec, [["snippet.title", title], ["snippet.description", description], ...tags.map((tag, i) => [`snippet.tags[${i}]`, tag] as [string, string])]);
        if (banned.length) {
            return json(422, { error: { code: 422, message: "The metadata contains terms that are not allowed.", errors: banned.map(b => ({ reason: "bannedTerm", field: b.field, term: b.term })) } },
                { kind: "api", log: { reason: "bannedTerm" } });
        }
        return null;
    }

    private async create(ctx: RequestContext, account: string): Promise<Reply> {
        const t = ctx.now;
        if (ctx.url.searchParams.get("uploadType") !== "resumable") return apiError(400, "invalidUploadType", "Only uploadType=resumable is supported.");
        const spec = this.spec();
        let body: { snippet?: Record<string, unknown>; status?: { privacyStatus?: unknown }; clientRef?: unknown };
        try { body = await ctx.json(); } catch { return apiError(400, "parseError", "The body is not JSON."); }
        const clientRef = typeof body.clientRef === "string" ? body.clientRef : typeof ctx.req.headers["idempotency-key"] === "string" ? ctx.req.headers["idempotency-key"] : null;
        const state = this.state();
        const origin = this.origin(ctx);
        if (clientRef) {
            const existing = Object.values(state.videos).find(v => v.account === account && v.clientRef === clientRef && this.videoState(v, t) !== "deleted");
            if (existing) {
                return json(200, { ...this.resource(existing, t, ctx), uploadUrl: `${origin}/upload/v1/sessions/${existing.session}` },
                    { kind: "api", headers: { location: `${origin}/upload/v1/sessions/${existing.session}`, "x-video-id": existing.id, "x-idempotent-replay": "true" }, log: { video: existing.id, reason: "replay" } });
            }
        }
        const total = Number(ctx.req.headers["x-upload-content-length"]);
        if (!Number.isInteger(total) || total <= 0) return apiError(400, "missingContentLength", "X-Upload-Content-Length is required.");
        if (total > (spec.maxBytes ?? 128 * 1024 ** 3)) return apiError(400, "fileTooLarge", "The file is larger than the limit.");
        const snippet = body.snippet ?? {};
        const problem = this.metadataProblem(spec, snippet);
        if (problem) return problem;

        state.counter++;
        const id = Buffer.from(hashHex(state.secret, "video", state.counter), "hex").toString("base64url").slice(0, 11);
        const sessionId = hashHex(state.secret, "session", state.counter).slice(0, 24);
        const nth = (state.created[account] ?? 0) + 1;
        state.created[account] = nth;
        const title = String(snippet.title);
        const description = typeof snippet.description === "string" ? snippet.description : "";
        const video: ApiVideo = {
            id, account, nth, createdAt: t, title, description, tags: Array.isArray(snippet.tags) ? snippet.tags.map(String) : [],
            category: snippet.categoryId === undefined ? null : String(snippet.categoryId),
            visibility: body.status?.privacyStatus === "private" ? "private" : "public",
            storedTitle: title, storedDescription: description, notices: [], limitedReason: null, media: null,
            clientRef, session: sessionId, removedAt: null, failureReason: null,
        };
        const contentType = String(ctx.req.headers["x-upload-content-type"] ?? "video/mp4");
        state.sessions[sessionId] = {
            id: sessionId, video: id, account, total, contentType, createdAt: t,
            expiresAt: t + (spec.uploadSessionTtlS ?? 86400) * 1000, received: 0, completedAt: null,
        };
        state.videos[id] = video;
        this.save(state); // the creation boundary: the id exists from here
        this.event(t, "video-created", { video: id, account, nth, clientRef, title, total, session: sessionId });
        const location = `${origin}/upload/v1/sessions/${sessionId}`;
        return json(200, { ...this.resource(video, t, ctx), uploadUrl: location }, { kind: "api", headers: { location, "x-video-id": id }, log: { video: id } });
    }

    private async put(ctx: RequestContext, account: string): Promise<Reply> {
        const t = ctx.now;
        const state = this.state();
        const session = state.sessions[ctx.params.session];
        if (!session || session.account !== account) return apiError(404, "uploadNotFound", "No such upload session.", {}, {}, "upload");
        const video = state.videos[session.video];
        const done = (status: 200 | 201) => json(status, this.resource(video, t, ctx), { kind: "upload", log: { video: video.id } });
        if (session.completedAt !== null) {
            await ctx.body();
            return done(200);
        }
        if (t >= session.expiresAt) return apiError(404, "uploadExpired", "The upload session expired.", {}, {}, "upload");
        const rangeHeader = String(ctx.req.headers["content-range"] ?? "");
        const data = await ctx.body();
        const incomplete = (log?: string): Reply => ({
            status: 308, kind: "upload",
            headers: session.received > 0 ? { range: `bytes=0-${session.received - 1}` } : {},
            log: { video: video.id, reason: log ?? `received ${session.received}/${session.total}` },
        });
        let start: number;
        const query = /^bytes \*\/(\d+)$/.exec(rangeHeader);
        const ranged = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(rangeHeader);
        if (query) {
            if (Number(query[1]) !== session.total) return apiError(400, "badContentRange", "The total does not match the session.", {}, {}, "upload");
            return incomplete("status query");
        } else if (ranged) {
            start = Number(ranged[1]);
            const end = Number(ranged[2]);
            if (Number(ranged[3]) !== session.total || end < start || end >= session.total || end - start + 1 !== data.length) {
                return apiError(400, "badContentRange", "Content-Range does not match the body or the session.", {}, {}, "upload");
            }
        } else if (!rangeHeader && data.length === session.total) {
            start = 0;
        } else {
            return apiError(400, "badContentRange", "Content-Range is required.", {}, {}, "upload");
        }
        if (start > session.received) {
            return apiError(400, "badContentRange", "The range starts after the bytes received so far.", { expectedOffset: session.received },
                session.received > 0 ? { range: `bytes=0-${session.received - 1}` } : {}, "upload");
        }
        let fresh = data.subarray(session.received - start);
        const fault = fresh.length > 0 ? this.faults().active("uploadFault", t)[0] : undefined;
        if (fault?.mode === "status") return apiError(fault.status ?? 503, "backendError", "The upload failed; resume it.", {}, {}, "upload");
        if (fault) fresh = fresh.subarray(0, Math.floor(fresh.length / 2)); // part of the body arrived
        if (fresh.length > 0) {
            session.received = this.mediaStore().append(join("sessions", `${session.id}.part`), fresh, session.received);
            this.save(state);
            this.event(t, "upload-bytes", { video: video.id, session: session.id, offset: session.received - fresh.length, bytes: fresh.length });
        }
        if (fault) {
            if (fault.mode === "stall") await sleep((fault.stallS ?? 90) * 1000);
            return { status: "reset", kind: "upload", log: { video: video.id, reason: `upload ${fault.mode}` } };
        }
        if (session.received < session.total) return incomplete();

        // Complete: probe, apply the duration limits, start processing.
        const store = this.mediaStore();
        const file = store.path("sessions", `${session.id}.part`);
        const { sha256, facts } = await store.facts(file);
        const spec = this.spec();
        if (facts && spec.minDurationS !== undefined && facts.durationS < spec.minDurationS) video.failureReason = "durationTooShort";
        if (facts && spec.maxDurationS !== undefined && facts.durationS > spec.maxDurationS) video.failureReason = "durationTooLong";
        video.media = { file, bytes: session.received, sha256, facts, at: t };
        session.completedAt = t;
        this.save(state);
        const tl = timeline(video, this.timelineSpec());
        this.event(t, "video-uploaded", {
            video: video.id, account, bytes: session.received, sha256, facts, processedAt: tl.processedAt, outcome: tl.outcome,
            recoversAt: tl.recoversAt, removedAt: tl.removedAt, removalKind: tl.removalKind, failureReason: video.failureReason ?? null,
            tiers: facts ? qualityTiers(facts).map(x => x.height) : [],
        });
        return done(201);
    }

    private list(ctx: RequestContext, account: string): Reply {
        const t = ctx.now;
        const q = ctx.url.searchParams;
        const spec = this.spec();
        const pageSize = Math.min(50, Math.max(1, Number(q.get("pageSize") ?? spec.pageSize ?? 25) || 25));
        const clientRef = q.get("clientRef");
        const status = q.get("status");
        const all = Object.values(this.state().videos)
            .filter(v => v.account === account && this.videoState(v, t) !== "deleted")
            .filter(v => clientRef === null || v.clientRef === clientRef)
            .filter(v => status === null || this.videoState(v, t) === status)
            .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        let from = 0;
        const token = q.get("pageToken");
        if (token) {
            let cursor: { c: number; id: string };
            try { cursor = JSON.parse(Buffer.from(token, "base64url").toString()); } catch { return apiError(400, "invalidPageToken", "Bad pageToken."); }
            from = all.findIndex(v => v.createdAt < cursor.c || (v.createdAt === cursor.c && v.id.localeCompare(cursor.id) < 0));
            if (from < 0) from = all.length;
        }
        const items = all.slice(from, from + pageSize);
        const last = items.at(-1);
        const more = from + pageSize < all.length;
        return json(200, {
            kind: "videoList", totalResults: all.length, items: items.map(v => this.resource(v, t, ctx)),
            ...(more && last ? { nextPageToken: Buffer.from(JSON.stringify({ c: last.createdAt, id: last.id })).toString("base64url") } : {}),
        }, { kind: "api", log: { count: items.length } });
    }

    private get(ctx: RequestContext, account: string): Reply {
        const v = this.findVideo(ctx.params.id, account, ctx.now);
        if (!v) return this.notFound(ctx.params.id);
        return json(200, this.resource(v, ctx.now, ctx), { kind: "api", log: { video: v.id } });
    }

    private async patch(ctx: RequestContext, account: string): Promise<Reply> {
        const t = ctx.now;
        const v = this.findVideo(ctx.params.id, account, t);
        if (!v) return this.notFound(ctx.params.id);
        let body: { snippet?: Record<string, unknown>; status?: { privacyStatus?: unknown } };
        try { body = await ctx.json(); } catch { return apiError(400, "parseError", "The body is not JSON."); }
        const snippet = { title: v.storedTitle, description: v.storedDescription, tags: v.tags, ...(body.snippet ?? {}) };
        const problem = this.metadataProblem(this.spec(), snippet);
        if (problem) return problem;
        const state = this.state();
        const stored = state.videos[v.id];
        stored.storedTitle = String(snippet.title);
        stored.storedDescription = String(snippet.description ?? "");
        stored.tags = Array.isArray(snippet.tags) ? snippet.tags.map(String) : [];
        if (body.snippet?.categoryId !== undefined) stored.category = String(body.snippet.categoryId);
        if (body.status?.privacyStatus === "private" || body.status?.privacyStatus === "public") stored.visibility = body.status.privacyStatus;
        this.save(state);
        this.event(t, "video-updated", { video: v.id, title: stored.storedTitle });
        return json(200, this.resource(stored, t, ctx), { kind: "api", log: { video: v.id } });
    }

    private remove(ctx: RequestContext, account: string): Reply {
        const t = ctx.now;
        const v = this.findVideo(ctx.params.id, account, t);
        if (!v) return this.notFound(ctx.params.id);
        const state = this.state();
        state.videos[v.id].removedAt = t;
        state.videos[v.id].removedBy = "client";
        this.save(state);
        this.event(t, "video-deleted", { video: v.id, by: "client" });
        return { status: 204, kind: "api", log: { video: v.id } };
    }

    // ---------- public pages and media ----------

    private watch(ctx: RequestContext): Reply {
        const v = this.state().videos[ctx.params.id];
        if (!v || this.videoState(v, ctx.now) !== "ready" || !v.media?.facts) return html(404, "<!doctype html><title>Not found</title><h1>Video unavailable</h1>", { log: { video: ctx.params.id } });
        const tiers = qualityTiers(v.media.facts);
        const links = tiers.map(x => `<a class="rendition" data-height="${x.height}" href="/media/${v.id}/${x.height}.mp4">${x.label}</a>`).join(" ");
        return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(v.storedTitle)}</title></head><body>
<h1>${escapeHtml(v.storedTitle)}</h1><video controls preload="none" src="/media/${v.id}/${tiers[0].height}.mp4"></video><p>${links}</p></body></html>`, { log: { video: v.id } });
    }

    private async mediaFile(ctx: RequestContext): Promise<Reply> {
        const fault = this.apiFault("media", ctx.now);
        if (fault) return fault;
        const v = this.state().videos[ctx.params.id];
        const height = Number(ctx.params.file.replace(/\.mp4$/, ""));
        const log = { video: ctx.params.id, reason: `${height}p` };
        if (!v || this.videoState(v, ctx.now) !== "ready" || !v.media?.facts) return json(404, { error: "not found" }, { kind: "media", log });
        const tier = qualityTiers(v.media.facts).find(x => x.height === height);
        if (!tier) return json(404, { error: "no such rendition" }, { kind: "media", log });
        const file = await this.mediaStore().rendition(v, tier);
        const plan = planRange(statSync(file).size, { range: ctx.req.headers.range }, { etag: `"${v.media.sha256.slice(0, 16)}-${height}"` });
        if (plan.status === 416) return { status: 416, kind: "media", headers: plan.headers, log };
        return {
            status: plan.status, kind: "media", headers: { ...plan.headers, "content-type": "video/mp4" },
            stream: fileStream(file, plan.start, plan.end), log: { ...log, ...(plan.status === 206 ? { range: `${plan.start}-${plan.end}` } : {}) },
        };
    }

    // ---------- control API ----------

    describe(t: number): Record<string, unknown> | null {
        const spec = this.sim.engine.scenario.sites[SITE];
        if (!spec) return null;
        const state = this.state();
        const day = new Date(t).toISOString().slice(0, 10);
        return {
            quota: spec.quota ? { dailyUnits: spec.quota.dailyUnits, used: state.quota[day] ?? 0 } : null,
            families: Object.values(state.families).map(f => ({ account: f.account, createdAt: f.createdAt, revoked: this.familyRevoked(f, t) })),
            videos: Object.values(state.videos).map(v => ({ id: v.id, account: v.account, clientRef: v.clientRef ?? null, title: v.storedTitle, state: this.videoState(v, t) })),
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
            this.event(t, "video-removed", { video: v.id, by: "control" });
            return { id: v.id, removedAt: t };
        }
        if (name === "revoke") {
            const account = typeof body.account === "string" ? body.account : undefined;
            for (const f of Object.values(state.families)) if ((!account || f.account === account) && f.revokedAt === null) f.revokedAt = t;
            this.save(state);
            this.event(t, "revoked", { account: account ?? null, by: "control" });
            return { ok: true };
        }
        if (name === "videos") return this.describe(t);
        throw new RangeError(`unknown action "${name}" (remove, revoke, videos)`);
    }
}
