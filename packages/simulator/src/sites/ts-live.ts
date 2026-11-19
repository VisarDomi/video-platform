// ts-live: a live site with account-gated HLS over MPEG-TS.
//
// Auth model:
// - A web login (form) issues a long-lived refresh token (cookie
//   refresh_token), a device cookie (device_id) and a session token
//   (session_token).
// - POST /api/session/refresh rotates the refresh token: the presented one
//   becomes invalid and a new one comes back with a fresh session token. Each
//   login starts a token family; families rotate independently.
// - A phone gets its own family through device provisioning (idempotent per
//   request id until acknowledged).
// - GET /api/stream/token trades a session token for a stream token (cookies
//   stream_token, stream_account, stream_expires) that lives about ten seconds. Playlists answer 401 without a
//   valid one; segments need no token.
// - The recording identity is the stream id; a stream that ended answers 404
//   on its playlists.
import type { ChannelModel, Session } from "../engine/channel.js";
import { hashHex } from "../rng.js";
import { html, HttpError, json, playlist, Router, setCookie, type Reply, type RequestContext } from "../http/server.js";
import type { Account, SiteSpec } from "../scenario/schema.js";
import type { Simulation, SiteModule } from "../sim.js";
import { masterPlaylist, mediaPlaylist, playlistFault, playlistLog, segmentReply } from "./hls.js";
import { mac, signToken, verifyToken, type Claims } from "./tokens.js";

const SITE = "ts-live" as const;

interface Family {
    id: string;
    accountId: string;
    kind: "web" | "device";
    generation: number;
    revoked: boolean;
    createdAt: number;
    deviceId: string;
}

interface Provision {
    requestId: string;
    familyId: string;
    accountId: string;
    deviceId: string;
    refreshToken: string;
    sessionToken: string;
    acknowledged: boolean;
}

interface AuthState {
    secret: string;
    counter: number;
    families: Record<string, Family>;
    provisions: Record<string, Provision>;
    follows: Record<string, string[]>;
}

interface RefreshClaims extends Claims { typ: "refresh"; sid: string; gen: number; kind: Family["kind"] }
interface SessionClaims extends Claims { typ: "session"; sid: string }

const STATE = "ts-live-auth";
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function streamIdOf(session: Session): string {
    return BigInt("0x" + session.key.slice(0, 13)).toString();
}

export class TsLiveSite implements SiteModule {
    readonly id = SITE;
    readonly router = new Router();

    constructor(private readonly sim: Simulation, private readonly scheme: "http" | "https" = "http") {
        const r = this.router;
        r.get("/", ctx => this.home(ctx));
        r.get("/login", () => this.loginPage());
        r.post("/login", ctx => this.login(ctx));
        r.post("/api/session/refresh", ctx => this.refresh(ctx));
        r.get("/api/stream/token", ctx => this.streamToken(ctx));
        r.post("/api/device/provision", ctx => this.provision(ctx));
        r.post("/api/device/acknowledge", ctx => this.acknowledge(ctx));
        r.post("/api/live/by-account-ids", ctx => this.liveByAccountIds(ctx));
        r.post("/api/profiles/batch", ctx => this.profiles(ctx));
        r.get("/api/followings", ctx => this.followings(ctx));
        r.post("/api/follow", ctx => this.follow(ctx));
        r.get("/hls/:stream/master.m3u8", ctx => this.master(ctx));
        r.get("/hls/:stream/:tier/playlist.m3u8", ctx => this.media(ctx));
        r.get("/hls/:stream/:tier/:segment", ctx => this.segment(ctx));
        r.get("/:name", ctx => this.channelPage(ctx));
    }

    // ---------- shared ----------

    private spec(): SiteSpec {
        const spec = this.sim.engine.siteSpec(SITE);
        if (!spec) throw new HttpError(404, "ts-live is not part of the current scenario");
        return spec;
    }

    private get ttl() {
        const spec = this.spec();
        return {
            stream: spec.streamTokenTtlS ?? 10,
            session: spec.sessionTokenTtlS ?? 3600,
            refresh: spec.refreshTokenTtlS ?? 30 * 86400,
        };
    }

    private state(): AuthState {
        const state = this.sim.store.read<AuthState | null>(STATE, null);
        if (state) return state;
        const fresh: AuthState = { secret: hashHex(this.sim.engine.seed, SITE, "signing"), counter: 0, families: {}, provisions: {}, follows: {} };
        this.sim.store.write(STATE, fresh);
        return fresh;
    }

    private save(state: AuthState): void {
        this.sim.store.write(STATE, state);
    }

    private event(t: number, event: string, fields: Record<string, unknown> = {}): void {
        this.sim.truth.append({ type: "event", t, site: SITE, event, ...fields });
    }

    private origin(ctx: RequestContext): string {
        return `${this.scheme}://${ctx.req.headers.host ?? "127.0.0.1"}`;
    }

    private apiFault(api: string, t: number): Reply | null {
        const fault = this.sim.engine.siteFaults(SITE, "apiStatus", t).find(f => f.api === undefined || f.api === api);
        if (!fault) return null;
        if (fault.status === "malformed") return json(200, { result: "unexpected" }, { kind: "api" });
        if (fault.status === "empty") return json(200, {}, { kind: "api" });
        return json(fault.status, { errorCode: "SERVICE_UNAVAILABLE" }, { kind: "api" });
    }

    recordingId(_model: ChannelModel, session: Session): string {
        return streamIdOf(session);
    }

    describeChannel(model: ChannelModel, t: number): Record<string, unknown> {
        const session = model.sessionAt(t);
        return { accountId: model.spec.id, streamId: session ? streamIdOf(session) : null };
    }

    private issueSession(state: AuthState, family: Family, now: number): { refresh: string; session: string } {
        const ttl = this.ttl;
        const iat = Math.floor(now / 1000);
        const refresh = signToken(state.secret, {
            sub: family.accountId, sid: family.id, gen: family.generation, kind: family.kind, typ: "refresh",
            iat, exp: iat + ttl.refresh, jti: `${family.id}.${family.generation}`,
        });
        const session = signToken(state.secret, { sub: family.accountId, sid: family.id, typ: "session", iat, exp: iat + ttl.session, n: family.generation });
        return { refresh, session };
    }

    private newFamily(state: AuthState, accountId: string, kind: Family["kind"], now: number): Family {
        state.counter++;
        const id = `${kind}-${hashHex(state.secret, "family", state.counter).slice(0, 12)}`;
        const family: Family = { id, accountId, kind, generation: 1, revoked: false, createdAt: now, deviceId: `dev-${hashHex(state.secret, "device", state.counter).slice(0, 16)}` };
        state.families[id] = family;
        return family;
    }

    private authCookies(tokens: { refresh: string; session: string }, family: Family): string[] {
        const ttl = this.ttl;
        return [
            setCookie("refresh_token", tokens.refresh, { maxAgeS: ttl.refresh, httpOnly: true }),
            setCookie("session_token", tokens.session, { maxAgeS: ttl.session }),
            setCookie("device_id", family.deviceId, { maxAgeS: ttl.refresh, httpOnly: true }),
        ];
    }

    /** The account behind a valid session token, or a 401 reply. */
    private requireSession(ctx: RequestContext, kind = "api"): { accountId: string; family: Family } | Reply {
        const state = this.state();
        const token = ctx.cookies["session_token"] ?? (ctx.req.headers.authorization?.startsWith("Bearer ") ? ctx.req.headers.authorization.slice(7) : undefined);
        const v = verifyToken<SessionClaims>(state.secret, token, ctx.now);
        if (!v.ok || v.claims.typ !== "session") {
            return json(401, { errorCode: v.ok ? "INVALID_TOKEN" : v.reason === "expired" ? "TOKEN_EXPIRED" : "INVALID_TOKEN" }, { kind, log: { reason: "session token" } });
        }
        const family = state.families[v.claims.sid];
        if (!family || family.revoked) return json(401, { errorCode: "SESSION_REVOKED" }, { kind });
        return { accountId: v.claims.sub, family };
    }

    // ---------- web login ----------

    private loginPage(): Reply {
        return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body>
<h1>Sign in</h1>
<form method="post" action="/login" data-testid="login-form">
  <label>Username <input name="username" autocomplete="username" data-testid="login-username"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" data-testid="login-password"></label>
  <button type="submit" data-testid="login-submit">Sign in</button>
</form></body></html>`);
    }

    private findAccount(username: string, password: string): Account | undefined {
        return (this.spec().accounts ?? []).find(a => a.username === username && a.password === password);
    }

    private async login(ctx: RequestContext): Promise<Reply> {
        const fields = await ctx.fields();
        const wantsJson = (ctx.req.headers.accept ?? "").includes("application/json") || (ctx.req.headers["content-type"] ?? "").includes("json");
        const account = this.findAccount(fields.username ?? "", fields.password ?? "");
        if (!account) {
            this.event(ctx.now, "login-failed", { username: fields.username ?? "" });
            return wantsJson ? json(401, { errorCode: "BAD_CREDENTIALS" }, { kind: "auth" })
                : html(401, `<!doctype html><p data-testid="login-error">Wrong username or password.</p><a href="/login">Try again</a>`, { kind: "auth" });
        }
        const state = this.state();
        const family = this.newFamily(state, account.accountId, "web", ctx.now);
        const tokens = this.issueSession(state, family, ctx.now);
        this.save(state);
        this.event(ctx.now, "login", { accountId: account.accountId, family: family.id });
        const headers = { "set-cookie": this.authCookies(tokens, family) };
        return wantsJson
            ? json(200, { accountId: account.accountId, sessionId: family.id }, { kind: "auth", headers })
            : { status: 303, kind: "auth", headers: { ...headers, location: "/" } };
    }

    // ---------- token refresh ----------

    private async refresh(ctx: RequestContext): Promise<Reply> {
        const fault = this.sim.engine.siteFaults(SITE, "refreshStatus", ctx.now)[0];
        if (fault) {
            // With an error code the client must sign in again; without one
            // (a block page) it is an outage and the tokens stay good.
            return fault.errorCode
                ? json(fault.status, { errorCode: fault.errorCode }, { kind: "auth" })
                : html(fault.status, "<!doctype html><title>Unavailable</title><p>Request blocked.</p>", { kind: "auth" });
        }
        const state = this.state();
        const token = ctx.cookies["refresh_token"];
        if (!token) return json(401, { errorCode: "SESSION_NOT_FOUND" }, { kind: "auth" });
        const v = verifyToken<RefreshClaims>(state.secret, token, ctx.now);
        if (!v.ok) return json(401, { errorCode: v.reason === "expired" ? "TOKEN_EXPIRED" : "INVALID_TOKEN" }, { kind: "auth" });
        const claims = v.claims;
        if (claims.typ !== "refresh") return json(401, { errorCode: "INVALID_TOKEN" }, { kind: "auth" });
        const family = state.families[claims.sid];
        if (!family) return json(401, { errorCode: "SESSION_NOT_FOUND" }, { kind: "auth" });
        if (family.revoked) return json(401, { errorCode: "SESSION_REVOKED" }, { kind: "auth" });
        if (ctx.cookies["device_id"] !== family.deviceId) return json(424, { errorCode: "CHALLENGE_REQUIRED" }, { kind: "auth" });
        let body: { accountId?: unknown; sessionId?: unknown } = {};
        try { body = await ctx.json(); } catch { /* checked below */ }
        if (body.accountId !== claims.sub || body.sessionId !== claims.sid) {
            return json(400, { errorCode: "BAD_REQUEST", message: "accountId and sessionId must match the refresh token" }, { kind: "auth" });
        }
        if (claims.gen !== family.generation) {
            // A rotated-out token: single use.
            if (this.spec().reuseRevokesFamily) family.revoked = true;
            this.save(state);
            this.event(ctx.now, "refresh-reused", { family: family.id, presented: claims.gen, current: family.generation, revoked: family.revoked });
            return json(401, { errorCode: family.revoked ? "SESSION_REVOKED" : "INVALID_TOKEN" }, { kind: "auth" });
        }
        family.generation++;
        const tokens = this.issueSession(state, family, ctx.now);
        this.save(state); // durable before the client can see the new token
        this.event(ctx.now, "refresh", { family: family.id, kind: family.kind, generation: family.generation });
        const ttl = this.ttl;
        return json(200, {
            accountId: family.accountId, sessionId: family.id,
            sessionExpiresAt: ctx.now + ttl.session * 1000, refreshExpiresAt: ctx.now + ttl.refresh * 1000,
            ...(family.kind === "device" ? { refreshToken: tokens.refresh, sessionToken: tokens.session } : {}),
        }, { kind: "auth", headers: { "set-cookie": this.authCookies(tokens, family) } });
    }

    private streamToken(ctx: RequestContext): Reply {
        const who = this.requireSession(ctx, "auth");
        if ("status" in who) return who;
        const state = this.state();
        const expires = Math.floor(ctx.now / 1000) + this.ttl.stream;
        const token = mac(state.secret, "stream", who.accountId, expires);
        this.event(ctx.now, "stream-token", { accountId: who.accountId, expiresAt: expires * 1000 });
        return json(200, { token, accountId: who.accountId, expires }, {
            kind: "auth",
            headers: { "set-cookie": [
                setCookie("stream_token", token, { maxAgeS: this.ttl.stream }), setCookie("stream_account", who.accountId), setCookie("stream_expires", String(expires)),
            ] },
        });
    }

    /** Null when the stream-token cookies are valid now, else the reason. */
    private streamTokenProblem(ctx: RequestContext): string | null {
        const { stream_token: token, stream_account: account, stream_expires: expires } = ctx.cookies;
        if (!token || !account || !expires) return "missing";
        const state = this.state();
        const expiry = Number(expires);
        if (mac(state.secret, "stream", account, expiry) !== token) return "invalid";
        if (expiry * 1000 <= ctx.now) return "expired";
        const revoke = this.sim.engine.lastSiteEvent(SITE, "tokenRevoke", ctx.now);
        if (revoke && (expiry - this.ttl.stream) * 1000 < this.sim.engine.epochMs + revoke.at * 1000) return "revoked";
        return null;
    }

    // ---------- device provisioning (the phone's own token family) ----------

    private async provision(ctx: RequestContext): Promise<Reply> {
        const who = this.requireSession(ctx, "auth");
        if ("status" in who) return who;
        const fields = await ctx.fields();
        const requestId = fields.requestId;
        if (!requestId || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return json(400, { errorCode: "BAD_REQUEST", message: "requestId (8-64 chars) required" }, { kind: "auth" });
        const state = this.state();
        const existing = state.provisions[requestId];
        if (existing) {
            if (existing.accountId !== who.accountId) return json(409, { errorCode: "REQUEST_ID_IN_USE" }, { kind: "auth" });
            if (existing.acknowledged) return json(409, { errorCode: "ALREADY_ACKNOWLEDGED" }, { kind: "auth" });
            const family = state.families[existing.familyId];
            // Retried before the device confirmed: the same credentials, unless they already rotated.
            if (family.generation === 1) {
                return json(200, this.provisionBody(existing), { kind: "auth" });
            }
            return json(409, { errorCode: "ALREADY_IN_USE" }, { kind: "auth" });
        }
        const family = this.newFamily(state, who.accountId, "device", ctx.now);
        const tokens = this.issueSession(state, family, ctx.now);
        const p: Provision = {
            requestId, familyId: family.id, accountId: who.accountId, deviceId: family.deviceId,
            refreshToken: tokens.refresh, sessionToken: tokens.session, acknowledged: false,
        };
        state.provisions[requestId] = p;
        this.save(state);
        this.event(ctx.now, "device-provisioned", { accountId: who.accountId, family: family.id, requestId });
        return json(200, this.provisionBody(p), { kind: "auth" });
    }

    private provisionBody(p: Provision) {
        return { requestId: p.requestId, accountId: p.accountId, sessionId: p.familyId, deviceId: p.deviceId, refreshToken: p.refreshToken, sessionToken: p.sessionToken };
    }

    private async acknowledge(ctx: RequestContext): Promise<Reply> {
        const fields = await ctx.fields();
        const state = this.state();
        const p = state.provisions[fields.requestId ?? ""];
        if (!p) return json(404, { errorCode: "UNKNOWN_REQUEST" }, { kind: "auth" });
        if (!p.acknowledged) {
            p.acknowledged = true;
            p.refreshToken = "";
            p.sessionToken = "";
            this.save(state);
            this.event(ctx.now, "device-acknowledged", { requestId: p.requestId, family: p.familyId });
        }
        return json(200, { requestId: p.requestId, acknowledged: true }, { kind: "auth" });
    }

    // ---------- catalog ----------

    private streamRecord(ctx: RequestContext, model: ChannelModel, session: Session, status: "LIVE" | "ENDED") {
        const id = streamIdOf(session);
        const masterUrl = `${this.origin(ctx)}/hls/${id}/master.m3u8`;
        return { stream: { accountId: model.spec.id, id, masterUrl, status, kind: "PUBLIC", startedAt: session.startMs } };
    }

    private async liveByAccountIds(ctx: RequestContext): Promise<Reply> {
        const who = this.requireSession(ctx);
        if ("status" in who) return who;
        const fault = this.apiFault("live", ctx.now);
        if (fault) return fault;
        const body = await ctx.json<{ accountIds?: unknown }>();
        if (!Array.isArray(body.accountIds) || body.accountIds.length > 500 || !body.accountIds.every(x => typeof x === "string")) {
            return json(400, { errorCode: "BAD_REQUEST", message: "accountIds: up to 500 strings" }, { kind: "api" });
        }
        const pageSize = Math.min(Number(ctx.url.searchParams.get("pageSize") ?? 100) || 100, 500);
        const wanted = new Set(body.accountIds as string[]);
        const records: unknown[] = [];
        const models = this.sim.engine.siteChannels(SITE);
        for (const model of models) {
            if (!wanted.has(model.spec.id)) continue;
            const live = model.sessionAt(ctx.now);
            if (live) { records.push(this.streamRecord(ctx, model, live, "LIVE")); continue; }
            const last = model.latestSession(ctx.now);
            if (last && last.endMs !== null && ctx.now < last.endMs + model.endlistMs) records.push(this.streamRecord(ctx, model, last, "ENDED"));
        }
        if (this.spec().extraRecords) {
            // Another account's stream, not asked for: clients must ignore it.
            const extra = models.find(m => !wanted.has(m.spec.id) && m.sessionAt(ctx.now));
            if (extra) records.push(this.streamRecord(ctx, extra, extra.sessionAt(ctx.now)!, "LIVE"));
        }
        const page = records.slice(0, pageSize);
        // An empty answer omits "records": only exactly this shape means "nobody is live".
        return json(200, page.length ? { code: "OK", totalCount: records.length, records: page } : { code: "OK", totalCount: 0 }, { kind: "api" });
    }

    private async profiles(ctx: RequestContext): Promise<Reply> {
        const who = this.requireSession(ctx);
        if ("status" in who) return who;
        const fault = this.apiFault("profiles", ctx.now);
        if (fault) return fault;
        const keys = await ctx.json<unknown>();
        if (!Array.isArray(keys) || keys.length > 500 || !keys.every(k => typeof k === "string")) {
            return json(400, { errorCode: "BAD_REQUEST", message: "a JSON array of up to 500 ids or names" }, { kind: "api" });
        }
        const out: Record<string, unknown> = {};
        for (const key of keys as string[]) {
            const model = this.sim.engine.siteChannels(SITE).find(m => m.spec.id === key
                || m.namesAt(ctx.now).some(n => n.toLowerCase() === key.toLowerCase()));
            if (!model) continue;
            const names = model.namesAt(ctx.now);
            out[key] = { accountId: model.spec.id, profile: { firstName: names[0], aliases: names.map(alias => ({ alias })) } };
        }
        return json(200, out, { kind: "api" });
    }

    private followsOf(accountId: string): string[] {
        const account = (this.spec().accounts ?? []).find(a => a.accountId === accountId);
        const base = account?.follows ?? this.sim.engine.siteChannels(SITE).map(m => m.spec.id);
        return [...new Set([...base, ...(this.state().follows[accountId] ?? [])])];
    }

    private followings(ctx: RequestContext): Reply {
        const who = this.requireSession(ctx);
        if ("status" in who) return who;
        const fault = this.apiFault("followings", ctx.now);
        if (fault) return fault;
        const size = Math.max(1, Math.min(Number(ctx.url.searchParams.get("size") ?? 100) || 100, 5000));
        return json(200, { following: this.followsOf(who.accountId).slice(0, size).map(accountId => ({ accountId })) }, { kind: "api" });
    }

    private async follow(ctx: RequestContext): Promise<Reply> {
        const who = this.requireSession(ctx);
        if ("status" in who) return who;
        const target = (await ctx.body()).toString().trim().replace(/^"|"$/g, "");
        if (!this.sim.engine.channel(SITE, target)) return json(404, { errorCode: "NOT_FOUND" }, { kind: "api" });
        const state = this.state();
        const list = state.follows[who.accountId] ?? [];
        if (!list.includes(target)) { list.push(target); state.follows[who.accountId] = list; this.save(state); }
        return json(200, { ok: true }, { kind: "api" });
    }

    // ---------- HLS ----------

    private findStream(id: string, t: number): { model: ChannelModel; session: Session } | null {
        for (const model of this.sim.engine.siteChannels(SITE)) {
            for (const session of model.sessionsBetween(t - 6 * 3600_000, t)) {
                if (session.startMs <= t && streamIdOf(session) === id) return { model, session };
            }
        }
        return null;
    }

    private master(ctx: RequestContext): Reply {
        this.spec();
        const found = this.findStream(ctx.params.stream, ctx.now);
        const log = { channel: found?.model.spec.id, session: found?.session.key };
        const problem = this.streamTokenProblem(ctx);
        if (problem) return json(401, { errorCode: "STREAM_TOKEN", reason: problem }, { kind: "master", log: { ...log, reason: `stream token ${problem}` } });
        if (!found) return json(404, { error: "no such stream" }, { kind: "master" });
        const { model, session } = found;
        const edge = model.edges[0];
        const fault = playlistFault({ model, session, edge, t: ctx.now }, "master");
        if (fault) return { ...fault, kind: "master", log: { ...log, edge: edge.id } };
        const w = model.window(session, edge, ctx.now, 0);
        if (w.gone) return json(404, { error: "stream ended" }, { kind: "master", log: { ...log, reason: "ended" } });
        if (model.spec.mediaAsMaster) return this.mediaReply(model, session, 0, ctx.now, "master");
        const id = ctx.params.stream;
        const variants = model.renditions.map((rendition, i) => ({ rendition, uri: `/hls/${id}/${rendition.id}/playlist.m3u8?v=${i}&` }));
        // Lowest first: a client that takes the first variant gets the worst one.
        variants.sort((a, b) => a.rendition.width * a.rendition.height - b.rendition.width * b.rendition.height);
        return playlist(masterPlaylist(variants), { kind: "master", log: { ...log, edge: edge.id } });
    }

    private mediaReply(model: ChannelModel, session: Session, tier: number, t: number, kind: "media" | "master"): Reply {
        const edge = model.edges[0];
        const w = model.window(session, edge, t, tier);
        if (w.gone) return json(404, { error: "stream ended" }, { kind, log: { channel: model.spec.id, session: session.key, reason: "ended" } });
        const id = streamIdOf(session);
        const body = mediaPlaylist(model, w, { format: "ts", uri: e => `/hls/${id}/${model.renditions[tier].id}/${e.k}.ts` });
        return playlist(body, { kind, log: playlistLog(model, w, tier) });
    }

    private media(ctx: RequestContext): Reply {
        this.spec();
        const found = this.findStream(ctx.params.stream, ctx.now);
        const problem = this.streamTokenProblem(ctx);
        if (problem) return json(401, { errorCode: "STREAM_TOKEN", reason: problem }, { kind: "media", log: { channel: found?.model.spec.id, reason: `stream token ${problem}` } });
        if (!found) return json(404, { error: "no such stream" }, { kind: "media" });
        const { model, session } = found;
        const tier = model.renditions.findIndex(r => r.id === ctx.params.tier);
        if (tier < 0) return json(404, { error: "no such variant" }, { kind: "media" });
        const fault = playlistFault({ model, session, edge: model.edges[0], t: ctx.now }, "media");
        if (fault) return { ...fault, kind: "media", log: { channel: model.spec.id, session: session.key, edge: model.edges[0].id } };
        return this.mediaReply(model, session, tier, ctx.now, "media");
    }

    private segment(ctx: RequestContext): Reply {
        this.spec();
        const found = this.findStream(ctx.params.stream, ctx.now);
        const m = /^(\d+)\.ts$/.exec(ctx.params.segment);
        if (!found || !m) return json(404, { error: "no such segment" }, { kind: "segment" });
        const { model, session } = found;
        const tier = model.renditions.findIndex(r => r.id === ctx.params.tier);
        return segmentReply(this.sim.library, { model, session, edge: model.edges[0], t: ctx.now }, tier, Number(m[1]));
    }

    // ---------- pages ----------

    private home(ctx: RequestContext): Reply {
        const models = this.sim.engine.siteChannels(SITE);
        const items = models.map(m => {
            const live = m.sessionAt(ctx.now) !== null;
            const name = m.nameAt(ctx.now);
            return `<li data-account-id="${escapeHtml(m.spec.id)}" data-live="${live}"><a href="/${encodeURIComponent(name)}">${escapeHtml(name)}</a>${live ? " (live)" : ""}</li>`;
        }).join("\n");
        const signedIn = this.requireSession(ctx);
        return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Live</title></head><body>
<header>${"status" in signedIn ? `<a href="/login" data-testid="visitor-sign-in">Sign in</a>` : `<span data-testid="signed-in">Signed in</span>`}</header>
<ul data-testid="channels">${items}</ul></body></html>`);
    }

    private channelPage(ctx: RequestContext): Reply {
        const model = this.sim.engine.siteChannels(SITE).find(m => m.namesAt(ctx.now).includes(ctx.params.name) || m.spec.id === ctx.params.name);
        if (!model) return html(404, "<!doctype html><p>Not found</p>");
        const session = model.sessionAt(ctx.now);
        const name = model.nameAt(ctx.now);
        return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title></head><body>
<main data-account-id="${escapeHtml(model.spec.id)}" data-live="${session !== null}"${session ? ` data-stream-id="${streamIdOf(session)}"` : ""}>
<h1>${escapeHtml(name)}</h1><p>${session ? "Live now" : "Offline"}</p></main></body></html>`);
    }
}
