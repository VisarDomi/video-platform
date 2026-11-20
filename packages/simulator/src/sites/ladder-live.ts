// ladder-live: a live site whose HLS address comes out of a control-channel
// handshake, with a quality ladder.
//
// - GET /api/channels?page=N lists live channels page by page:
//   {page, pageCount, channel: [{id, name, started_at, paid}]}. paid != 0
//   means paid (not recordable). {channel: []} is the authoritative "nobody
//   live".
// - POST /api/control/open {channel_id} returns a control URL and token. The
//   control channel is message based, carried over HTTP long-poll:
//     GET  <url>/recv?after=N&wait=ms   -> {messages: [{index, message}]}
//     POST <url>/send {name, id, arguments}
//   The server first sends {name: "ready"}. A client sends
//   {name: "get_stream_info", id, arguments: {mode?}} and receives
//   {name: "reply", id, arguments: {master, url?, playlists: [{url, mode,
//   latency}]}}. Replies carry the request id; unsolicited messages (viewer
//   counts) arrive in between. {name: "heartbeat", id} keeps the channel open
//   (60 s idle limit); {name: "closed"} ends it.
// - mode = quality * 10 + latency. Quality 5/4/3 = top/middle/bottom rung;
//   latency 0 = low, 1 = high, 2 = middle.
// - Once a stream ends (or while it is paid), its master and playlists answer
//   403 (or an empty master, per scenario). The recording identity is the
//   session's started_at.
import type { ChannelModel, Session } from "../engine/channel.js";
import { html, HttpError, json, playlist, Router, setCookie, type Reply, type RequestContext } from "../http/server.js";
import { hashHex } from "../rng.js";
import type { SiteSpec } from "../scenario/schema.js";
import type { Simulation, SiteModule } from "../sim.js";
import { masterPlaylist, mediaPlaylist, playlistFault, playlistLog, segmentReply } from "./hls.js";

const SITE = "ladder-live" as const;
const IDLE_LIMIT_MS = 60_000;
const MAX_WAIT_MS = 25_000;
const LATENCIES = [0, 1, 2];
const LATENCY_NAMES = ["low", "high", "middle"];

export const qualityOf = (tier: number) => 5 - tier;
export const modeOf = (tier: number, latency: number) => qualityOf(tier) * 10 + latency;
export const tierOfMode = (mode: number) => 5 - Math.floor(mode / 10);

interface ControlSession {
    token: string;
    channel: string;
    sessionKey: string;
    messages: Array<{ index: number; message: unknown }>;
    lastSeen: number;
    lastCount: number;
    closed: boolean;
    waiters: Set<() => void>;
}

export class LadderLiveSite implements SiteModule {
    readonly id = SITE;
    readonly router = new Router();
    private readonly controls = new Map<string, ControlSession>();
    private counter = 0;

    constructor(private readonly sim: Simulation, private readonly scheme: "http" | "https" = "http") {
        const r = this.router;
        r.get("/", ctx => this.home(ctx));
        r.get("/login/", ctx => this.login(ctx));
        r.get("/api/channels", ctx => this.channels(ctx));
        r.post("/api/member", ctx => this.member(ctx));
        r.post("/api/control/open", ctx => this.open(ctx));
        r.get("/control/:token/recv", ctx => this.recv(ctx));
        r.post("/control/:token/send", ctx => this.send(ctx));
        r.get("/hls/stream/:channel/:session/master.m3u8", ctx => this.master(ctx));
        r.get("/hls/stream/:channel/:session/:mode/playlist.m3u8", ctx => this.media(ctx));
        r.get("/hls/stream/:channel/:session/:quality/:segment", ctx => this.segment(ctx));
        r.get("/:id", ctx => this.channelPage(ctx));
    }

    private spec(): SiteSpec {
        const spec = this.sim.engine.siteSpec(SITE);
        if (!spec) throw new HttpError(404, "ladder-live is not part of the current scenario");
        return spec;
    }

    recordingId(_model: ChannelModel, session: Session): string {
        return String(Math.floor(session.startMs / 1000));
    }

    describeChannel(model: ChannelModel, t: number): Record<string, unknown> {
        const session = model.sessionAt(t);
        return { started_at: session ? Math.floor(session.startMs / 1000) : null, paid: session ? this.paid(model, session, t) : false };
    }

    private paid(model: ChannelModel, session: Session, t: number): boolean {
        return model.active(session, "paid", t).length > 0;
    }

    private apiFault(api: string, t: number): Reply | null {
        const fault = this.sim.engine.siteFaults(SITE, "apiStatus", t).find(f => f.api === undefined || f.api === api);
        if (!fault) return null;
        if (fault.status === "malformed") return json(200, { result: "maintenance" }, { kind: "api" });
        if (fault.status === "empty") return json(200, {}, { kind: "api" });
        return json(fault.status, { error: "unavailable" }, { kind: "api" });
    }

    private origin(ctx: RequestContext): string {
        return `${this.scheme}://${ctx.req.headers.host ?? "127.0.0.1"}`;
    }

    // ---------- catalog ----------

    private channels(ctx: RequestContext): Reply {
        const spec = this.spec();
        const fault = this.apiFault("channels", ctx.now);
        if (fault) return fault;
        const pageSize = spec.pageSize ?? 50;
        const live = this.sim.engine.siteChannels(SITE)
            .map(model => ({ model, session: model.sessionAt(ctx.now) }))
            .filter((x): x is { model: ChannelModel; session: Session } => x.session !== null)
            .sort((a, b) => Number(a.model.spec.id) - Number(b.model.spec.id));
        const pageCount = Math.ceil(live.length / pageSize);
        const page = Math.max(1, Number(ctx.url.searchParams.get("page") ?? 1) || 1);
        const channel = live.slice((page - 1) * pageSize, page * pageSize).map(({ model, session }) => ({
            id: model.spec.id, name: model.nameAt(ctx.now), started_at: Math.floor(session.startMs / 1000),
            paid: this.paid(model, session, ctx.now) ? 1 : 0,
        }));
        return json(200, { page, pageCount, pageSize, total: live.length, channel }, { kind: "api" });
    }

    private async member(ctx: RequestContext): Promise<Reply> {
        this.spec();
        const fault = this.apiFault("member", ctx.now);
        if (fault) return fault;
        const fields = await ctx.fields();
        const model = this.sim.engine.channel(SITE, fields.channel_id ?? "");
        // Every number answers; an unknown channel has an empty profile.
        return json(200, { profile: model ? { id: model.spec.id, name: model.nameAt(ctx.now) } : {} }, { kind: "api" });
    }

    // ---------- control channel ----------

    private async open(ctx: RequestContext): Promise<Reply> {
        this.spec();
        const fault = this.apiFault("control", ctx.now);
        if (fault) return fault;
        const fields = await ctx.fields();
        const model = this.sim.engine.channel(SITE, fields.channel_id ?? "");
        const session = model?.sessionAt(ctx.now) ?? null;
        if (!model || !session) return json(200, { status: 2, reason: "offline" }, { kind: "control" });
        if (this.paid(model, session, ctx.now)) return json(200, { status: 3, reason: "paid" }, { kind: "control" });
        this.sweep(ctx.now);
        this.counter++;
        const token = hashHex(this.sim.engine.seed, SITE, "control", model.spec.id, session.key, this.counter, ctx.now).slice(0, 24);
        const control: ControlSession = {
            token, channel: model.spec.id, sessionKey: session.key, messages: [], lastSeen: ctx.now, lastCount: ctx.now,
            closed: false, waiters: new Set(),
        };
        this.controls.set(token, control);
        this.push(control, { name: "ready" });
        return json(200, { status: 0, url: `${this.origin(ctx)}/control/${token}`, token }, { kind: "control", log: { channel: model.spec.id, session: session.key } });
    }

    private sweep(now: number): void {
        for (const [token, c] of this.controls) if (now - c.lastSeen > IDLE_LIMIT_MS * 2) this.controls.delete(token);
    }

    private push(control: ControlSession, message: unknown): void {
        control.messages.push({ index: control.messages.length + 1, message });
        for (const wake of control.waiters) wake();
    }

    /** The control session, after closing it if its stream ended or it sat idle. */
    private control(ctx: RequestContext): ControlSession | Reply {
        const control = this.controls.get(ctx.params.token);
        if (!control) return json(404, { error: "unknown control session" }, { kind: "control" });
        if (!control.closed) {
            const model = this.sim.engine.channel(SITE, control.channel);
            const live = model?.sessionAt(ctx.now);
            if (ctx.now - control.lastSeen > IDLE_LIMIT_MS) {
                control.closed = true;
                this.push(control, { name: "closed", arguments: { code: 4101, reason: "idle" } });
            } else if (!live || live.key !== control.sessionKey) {
                control.closed = true;
                this.push(control, { name: "closed", arguments: { code: 4512, reason: "stream ended" } });
            } else if (ctx.now - control.lastCount >= 10_000) {
                control.lastCount = ctx.now;
                this.push(control, { name: "viewers", arguments: { count: 10 + (Math.floor(ctx.now / 10_000) % 50) } });
            }
        }
        control.lastSeen = ctx.now;
        return control;
    }

    private async recv(ctx: RequestContext): Promise<Reply> {
        const control = this.control(ctx);
        if ("status" in control) return control;
        const after = Number(ctx.url.searchParams.get("after") ?? 0) || 0;
        const wait = Math.min(Math.max(Number(ctx.url.searchParams.get("wait") ?? 0) || 0, 0), MAX_WAIT_MS);
        const pending = () => control.messages.filter(m => m.index > after);
        if (pending().length === 0 && !control.closed && wait > 0) {
            await new Promise<void>(resolve => {
                const wake = () => { clearTimeout(timer); control.waiters.delete(wake); resolve(); };
                const timer = setTimeout(wake, wait);
                control.waiters.add(wake);
            });
        }
        const messages = pending();
        if (messages.length === 0 && control.closed) return json(410, { error: "control session closed" }, { kind: "control" });
        return json(200, { messages }, { kind: "control", log: { channel: control.channel, session: control.sessionKey } });
    }

    private async send(ctx: RequestContext): Promise<Reply> {
        const control = this.control(ctx);
        if ("status" in control) return control;
        if (control.closed) return json(410, { error: "control session closed" }, { kind: "control" });
        const message = await ctx.json<{ name?: unknown; id?: unknown; arguments?: Record<string, unknown> }>();
        if (typeof message.name !== "string") return json(400, { error: "a message has a name" }, { kind: "control" });
        const id = message.id;
        if (message.name === "heartbeat") {
            this.push(control, { name: "reply", id, arguments: { status: 0 } });
        } else if (message.name === "get_stream_info") {
            this.push(control, { name: "reply", id, arguments: this.hlsInformation(ctx, control, message.arguments ?? {}) });
        } else {
            this.push(control, { name: "reply", id, arguments: { status: 1, error: `unknown command ${message.name}` } });
        }
        return json(200, { accepted: true }, { kind: "control", log: { channel: control.channel, reason: message.name } });
    }

    private hlsInformation(ctx: RequestContext, control: ControlSession, args: Record<string, unknown>) {
        const model = this.sim.engine.channel(SITE, control.channel)!;
        const base = `${this.origin(ctx)}/hls/stream/${control.channel}/${control.sessionKey}`;
        const playlists = LATENCIES.flatMap(latency => model.renditions.map((_, tier) => ({
            url: `${base}/${modeOf(tier, latency)}/playlist.m3u8`, mode: modeOf(tier, latency), latency: LATENCY_NAMES[latency],
        })));
        const out: Record<string, unknown> = { status: 0, master: `${base}/master.m3u8`, playlists };
        if (args.mode !== undefined) {
            const mode = Number(args.mode);
            const tier = tierOfMode(mode);
            if (!LATENCIES.includes(mode % 10) || tier < 0 || tier >= model.renditions.length) return { status: 1, error: `no such mode ${args.mode}` };
            out.url = `${base}/${mode}/playlist.m3u8`;
        }
        return out;
    }

    // ---------- HLS ----------

    private resolve(ctx: RequestContext): { model: ChannelModel; session: Session } | null {
        const model = this.sim.engine.channel(SITE, ctx.params.channel);
        const session = model?.sessionByKey(ctx.params.session, ctx.now);
        return model && session ? { model, session } : null;
    }

    private denied(ctx: RequestContext, found: { model: ChannelModel; session: Session } | null, kind: "master" | "media"): Reply | null {
        const spec = this.spec();
        if (spec.requireOrigin) {
            const origin = ctx.req.headers.origin ?? ctx.req.headers.referer ?? "";
            if (!origin.startsWith(this.origin(ctx))) return json(403, { error: "origin required" }, { kind, log: { reason: "origin" } });
        }
        const log = { channel: ctx.params.channel, session: ctx.params.session };
        if (!found) return json(403, { error: "forbidden" }, { kind, log: { ...log, reason: "unknown or old session" } });
        const { model, session } = found;
        const w = model.window(session, model.edges[0], ctx.now);
        if (w.gone) {
            if (kind === "master" && spec.endMaster === "empty") return playlist("#EXTM3U\n", { kind, log: { ...log, reason: "ended" } });
            return json(403, { error: "forbidden" }, { kind, log: { ...log, reason: "ended" } });
        }
        if (this.paid(model, session, ctx.now)) return json(403, { error: "forbidden" }, { kind, log: { ...log, reason: "paid" } });
        const fault = playlistFault({ model, session, edge: model.edges[0], t: ctx.now }, kind);
        return fault ? { ...fault, kind, log: { ...log, edge: model.edges[0].id } } : null;
    }

    private master(ctx: RequestContext): Reply {
        const found = this.resolve(ctx);
        const denied = this.denied(ctx, found, "master");
        if (denied) return denied;
        const { model, session } = found!;
        const base = `/hls/stream/${model.spec.id}/${session.key}`;
        const variants = model.renditions.map((rendition, tier) => ({ rendition, uri: `${base}/${modeOf(tier, 0)}/playlist.m3u8` }));
        return playlist(masterPlaylist(variants), { kind: "master", log: { channel: model.spec.id, session: session.key } });
    }

    private media(ctx: RequestContext): Reply {
        const found = this.resolve(ctx);
        const denied = this.denied(ctx, found, "media");
        if (denied) return denied;
        const { model, session } = found!;
        const mode = Number(ctx.params.mode);
        const tier = tierOfMode(mode);
        if (!Number.isInteger(mode) || !LATENCIES.includes(mode % 10) || tier < 0 || tier >= model.renditions.length) {
            return json(404, { error: "no such mode" }, { kind: "media" });
        }
        const edge = model.edges[0];
        const w = model.window(session, edge, ctx.now, tier);
        const base = `/hls/stream/${model.spec.id}/${session.key}/${qualityOf(tier)}`;
        const body = mediaPlaylist(model, w, { format: "ts", uri: e => `${base}/${e.k}.ts` });
        return playlist(body, { kind: "media", log: playlistLog(model, w, tier) });
    }

    private segment(ctx: RequestContext): Reply {
        this.spec();
        const found = this.resolve(ctx);
        const m = /^(\d+)\.ts$/.exec(ctx.params.segment);
        if (!found || !m) return json(404, { error: "no such segment" }, { kind: "segment" });
        const { model, session } = found;
        return segmentReply(this.sim.library, { model, session, edge: model.edges[0], t: ctx.now }, 5 - Number(ctx.params.quality), Number(m[1]));
    }

    // ---------- pages ----------

    private home(ctx: RequestContext): Reply {
        const items = this.sim.engine.siteChannels(SITE).filter(m => m.sessionAt(ctx.now))
            .map(m => `<li><a href="/${m.spec.id}">${m.nameAt(ctx.now)}</a></li>`).join("\n");
        return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Roland-Garros · Live courts</title></head><body><ul data-testid="live">${items}</ul></body></html>`);
    }

    private login(ctx: RequestContext): Reply {
        const back = ctx.url.searchParams.get("back") ?? "/";
        return { status: 303, kind: "page", headers: { "set-cookie": setCookie("member", "1", { maxAgeS: 86400 * 30 }), location: back.startsWith("/") ? back : "/" } };
    }

    private channelPage(ctx: RequestContext): Reply {
        if (!/^\d+$/.test(ctx.params.id)) return html(404, "<!doctype html><p>Not found</p>");
        const model = this.sim.engine.channel(SITE, ctx.params.id);
        if (!model) return html(404, "<!doctype html><p>No such channel</p>");
        const session = model.sessionAt(ctx.now);
        const loggedIn = ctx.cookies["member"] === "1";
        return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>${model.nameAt(ctx.now)}</title></head><body>
${loggedIn ? "" : `<a href="/login/?back=/${model.spec.id}" data-testid="login">Log in</a>`}
<main data-channel-id="${model.spec.id}" data-live="${session !== null}"><h1>${model.nameAt(ctx.now)}</h1></main></body></html>`);
    }
}
