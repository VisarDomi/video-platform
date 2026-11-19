// fmp4-live: a live site serving fMP4 (CMAF) from several CDN edges.
//
// - GET /api/channels/status?ids=1,2 (or ids[]=1&ids[]=2; up to 100) is the
//   bulk status: {channels: [{id, name, status, live, online, statusSince}]},
//   status public | private | group | off. Only public + live is
//   recordable; "online" is unreliable (false at times while live). A body
//   without "channels" means "unavailable".
// - GET /api/channels/:id/stream gives the stream name and the edges.
// - GET /api/channels/by-name/:name resolves a name, old names included
//   ({id, name, renamedTo?}); 404 = no such channel.
// - Every edge serves the same stream at /edge/<edge>/hls/<stream>/...:
//   a master (variants named "source" and "<height>p", each with its own init
//   map), media playlists with #EXT-X-MAP and a program date-time on every
//   entry, and fragments. Edges number independently, lag and skew a little,
//   and fail independently (scripted outages).
// - Private and group shows answer 403 on every playlist; the recording
//   identity is statusSince, which moves at every status change.
// - Obfuscated channels encode segment URIs (see obfuscation.ts).
import type { ChannelModel, Edge, Session } from "../engine/channel.js";
import { html, HttpError, json, playlist, Router, type Reply, type RequestContext } from "../http/server.js";
import { unit } from "../rng.js";
import type { SiteSpec } from "../scenario/schema.js";
import type { Simulation, SiteModule } from "../sim.js";
import { initReply, masterPlaylist, mediaPlaylist, playlistFault, playlistLog, segmentReply } from "./hls.js";
import { encodeUri, KEY_TAG, PLACEHOLDER, URI_TAG } from "./obfuscation.js";

const SITE = "fmp4-live" as const;
const MAX_BULK = 100;

export type ShowStatus = "public" | "private" | "group" | "off";

const isoSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

export function streamNameOf(model: ChannelModel, session: Session): string {
    return `s${model.spec.id}-${session.key.slice(0, 10)}`;
}

export class Fmp4LiveSite implements SiteModule {
    readonly id = SITE;
    readonly router = new Router();

    constructor(private readonly sim: Simulation, private readonly scheme: "http" | "https" = "http") {
        const r = this.router;
        r.get("/", ctx => this.home(ctx));
        r.get("/api/channels/status", ctx => this.status(ctx));
        r.get("/api/channels/:id/stream", ctx => this.streamInfo(ctx));
        r.get("/api/channels/by-name/:name", ctx => this.byName(ctx));
        r.get("/edge/:edge/hls/:stream/master.m3u8", ctx => this.master(ctx));
        r.get("/edge/:edge/hls/:stream/:tier/playlist.m3u8", ctx => this.media(ctx));
        r.get("/edge/:edge/hls/:stream/:tier/init.mp4", ctx => this.init(ctx));
        r.get("/edge/:edge/hls/:stream/:tier/:segment", ctx => this.segment(ctx));
        r.get("/:name", ctx => this.page(ctx));
    }

    private spec(): SiteSpec {
        const spec = this.sim.engine.siteSpec(SITE);
        if (!spec) throw new HttpError(404, "fmp4-live is not part of the current scenario");
        return spec;
    }

    private apiFault(api: string, t: number): Reply | null {
        const fault = this.sim.engine.siteFaults(SITE, "apiStatus", t).find(f => f.api === undefined || f.api === api);
        if (!fault) return null;
        if (fault.status === "malformed") return json(200, { error: "temporarily unavailable" }, { kind: "api" });
        if (fault.status === "empty") return json(200, {}, { kind: "api" });
        return json(fault.status, { error: "unavailable" }, { kind: "api" });
    }

    // ---------- status model ----------

    /** Show status at `t` and when it last changed. */
    showStatus(model: ChannelModel, t: number): { status: ShowStatus; changedAt: number; session: Session | null } {
        const session = model.sessionAt(t);
        if (!session) {
            const last = model.latestSession(t);
            return { status: "off", changedAt: last?.endMs ?? model.epochMs, session: null };
        }
        let changedAt = session.startMs;
        let status: ShowStatus = "public";
        for (const f of model.faults(session)) {
            if (f.fault.type !== "showState") continue;
            const from = Math.max(f.fromMs, session.startMs);
            if (from <= t && t < f.untilMs) { status = f.fault.state; changedAt = Math.max(changedAt, from); }
            else if (f.untilMs <= t && f.untilMs > session.startMs) changedAt = Math.max(changedAt, f.untilMs);
        }
        return { status, changedAt, session };
    }

    recordingId(model: ChannelModel, session: Session): string {
        return isoSeconds(this.showStatus(model, session.startMs).changedAt);
    }

    describeChannel(model: ChannelModel, t: number): Record<string, unknown> {
        const s = this.showStatus(model, t);
        return { status: s.status, statusSince: isoSeconds(s.changedAt), streamName: s.session ? streamNameOf(model, s.session) : null, edges: model.edges.map(e => e.id) };
    }

    private channelView(model: ChannelModel, t: number) {
        const s = this.showStatus(model, t);
        const live = s.session !== null;
        // "online" is not to be trusted: false now and then while live.
        const online = live && unit(this.sim.engine.seed, SITE, model.spec.id, "online", Math.floor(t / 30_000)) > 0.25;
        return { id: Number(model.spec.id), name: model.nameAt(t), status: s.status, live, online, statusSince: isoSeconds(s.changedAt) };
    }

    // ---------- APIs ----------

    private status(ctx: RequestContext): Reply {
        this.spec();
        const fault = this.apiFault("status", ctx.now);
        if (fault) return fault;
        const ids = [...ctx.url.searchParams.getAll("ids[]"), ...ctx.url.searchParams.getAll("ids").flatMap(v => v.split(","))].filter(Boolean);
        if (ids.length > MAX_BULK) return json(400, { error: `at most ${MAX_BULK} ids` }, { kind: "api" });
        const channels = ids.map(id => this.sim.engine.channel(SITE, id)).filter((m): m is ChannelModel => m !== undefined)
            .map(m => this.channelView(m, ctx.now));
        return json(200, { channels }, { kind: "api" });
    }

    private streamInfo(ctx: RequestContext): Reply {
        this.spec();
        const fault = this.apiFault("stream", ctx.now);
        if (fault) return fault;
        const model = this.sim.engine.channel(SITE, ctx.params.id);
        if (!model) return json(404, { error: "not found" }, { kind: "api" });
        const s = this.showStatus(model, ctx.now);
        const origin = `${this.scheme}://${ctx.req.headers.host ?? "127.0.0.1"}`;
        const streamName = s.session ? streamNameOf(model, s.session) : null;
        return json(200, {
            channel: this.channelView(model, ctx.now),
            stream: {
                name: streamName, available: s.status === "public", active: s.session !== null, statusSince: isoSeconds(s.changedAt),
                edges: model.edges.map(e => e.id),
                masterUrls: streamName ? Object.fromEntries(model.edges.map(e => [e.id, `${origin}/edge/${e.id}/hls/${streamName}/master.m3u8`])) : {},
            },
        }, { kind: "api" });
    }

    private byName(ctx: RequestContext): Reply {
        this.spec();
        const fault = this.apiFault("names", ctx.now);
        if (fault) return fault;
        const wanted = ctx.params.name.toLowerCase();
        const model = this.sim.engine.siteChannels(SITE).find(m => m.namesAt(ctx.now).some(n => n.toLowerCase() === wanted));
        if (!model) return json(404, { error: "no such user" }, { kind: "api" });
        const current = model.nameAt(ctx.now);
        return json(200, { id: Number(model.spec.id), name: current, ...(current.toLowerCase() !== wanted ? { renamedTo: current } : {}) }, { kind: "api" });
    }

    // ---------- HLS ----------

    private resolve(ctx: RequestContext): { model: ChannelModel; session: Session; edge: Edge } | null {
        this.spec();
        const m = /^s(\d+)-([0-9a-f]{10})$/.exec(ctx.params.stream);
        if (!m) return null;
        const model = this.sim.engine.channel(SITE, m[1]);
        const edge = model?.edge(ctx.params.edge);
        if (!model || !edge) return null;
        const session = model.sessionsBetween(ctx.now - 6 * 3600_000, ctx.now).find(s => s.key.startsWith(m[2]) && s.startMs <= ctx.now);
        return session ? { model, session, edge } : null;
    }

    private gate(ctx: RequestContext, found: ReturnType<Fmp4LiveSite["resolve"]>, kind: "master" | "media"): Reply | null {
        if (!found) return json(404, { error: "not found" }, { kind });
        const { model, session, edge } = found;
        const log = { channel: model.spec.id, session: session.key, edge: edge.id };
        const fault = playlistFault({ model, session, edge, t: ctx.now }, kind);
        if (fault) return { ...fault, kind, log };
        const w = model.window(session, edge, ctx.now);
        if (w.gone) return json(404, { error: "stream ended" }, { kind, log: { ...log, reason: "ended" } });
        const show = this.showStatus(model, ctx.now);
        if (show.status === "private" || show.status === "group") return json(403, { error: "forbidden" }, { kind, log: { ...log, reason: show.status } });
        return null;
    }

    private keyId(t: number): string | null {
        const obf = this.spec().obfuscation;
        if (!obf) return null;
        return this.sim.engine.lastSiteEvent(SITE, "obfuscationKey", t)?.keyId ?? obf.keyId;
    }

    private master(ctx: RequestContext): Reply {
        const found = this.resolve(ctx);
        const gated = this.gate(ctx, found, "master");
        if (gated) return gated;
        const { model, session, edge } = found!;
        const base = `/edge/${edge.id}/hls/${ctx.params.stream}`;
        const variants = model.renditions.map((rendition, tier) => ({
            rendition, name: tier === 0 ? "source" : `${rendition.height}p`, uri: `${base}/${rendition.id}/playlist.m3u8`,
        }));
        const keyId = model.spec.obfuscated ? this.keyId(ctx.now) : null;
        const tags = keyId ? [`${KEY_TAG}ID=${keyId}`] : [];
        return playlist(masterPlaylist(variants, tags), { kind: "master", log: { channel: model.spec.id, session: session.key, edge: edge.id } });
    }

    private media(ctx: RequestContext): Reply {
        const found = this.resolve(ctx);
        const gated = this.gate(ctx, found, "media");
        if (gated) return gated;
        const { model, session, edge } = found!;
        const tier = model.renditions.findIndex(r => r.id === ctx.params.tier);
        if (tier < 0) return json(404, { error: "no such variant" }, { kind: "media" });
        const w = model.window(session, edge, ctx.now, tier);
        const base = `/edge/${edge.id}/hls/${ctx.params.stream}`;
        const keyId = model.spec.obfuscated ? this.keyId(ctx.now) : null;
        const secret = keyId ? this.spec().obfuscation!.keys[keyId] : null;
        const body = mediaPlaylist(model, w, {
            format: "fmp4",
            uri: e => `${base}/${model.renditions[tier].id}/${e.k}.m4s`,
            mapUri: r => `${base}/${model.renditions[r].id}/init.mp4`,
            headerTags: keyId ? [`${KEY_TAG}ID=${keyId}`] : [],
            entryLines: secret ? (_e, uri) => [`${URI_TAG}${encodeUri(uri, secret)}`, `${base}/${model.renditions[tier].id}/${PLACEHOLDER}`] : undefined,
        });
        return playlist(body, { kind: "media", log: playlistLog(model, w, tier) });
    }

    private init(ctx: RequestContext): Reply {
        const found = this.resolve(ctx);
        if (!found) return json(404, { error: "not found" }, { kind: "init" });
        const { model, session, edge } = found;
        const log = { channel: model.spec.id, session: session.key, edge: edge.id };
        const outage = model.active(session, "edgeOutage", ctx.now, edge.id)[0];
        if (outage) return outage.fault.status === "reset" ? { status: "reset", kind: "init", log } : json(outage.fault.status, { error: "unavailable" }, { kind: "init", log });
        return initReply(this.sim.library, model, model.renditions.findIndex(r => r.id === ctx.params.tier), log);
    }

    private segment(ctx: RequestContext): Reply {
        const found = this.resolve(ctx);
        const m = /^(\d+)\.m4s$/.exec(ctx.params.segment);
        if (!found || !m) return json(404, { error: ctx.params.segment === PLACEHOLDER ? "placeholder: decode the playlist" : "no such segment" }, { kind: "segment" });
        const { model, session, edge } = found;
        return segmentReply(this.sim.library, { model, session, edge, t: ctx.now }, model.renditions.findIndex(r => r.id === ctx.params.tier), Number(m[1]));
    }

    // ---------- pages ----------

    private home(ctx: RequestContext): Reply {
        const items = this.sim.engine.siteChannels(SITE).map(m => {
            const s = this.showStatus(m, ctx.now);
            return `<li data-channel-id="${m.spec.id}" data-status="${s.status}"><a href="/${m.nameAt(ctx.now)}">${m.nameAt(ctx.now)}</a></li>`;
        }).join("\n");
        return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Live</title></head><body><ul data-testid="channels">${items}</ul></body></html>`);
    }

    private page(ctx: RequestContext): Reply {
        const model = this.sim.engine.siteChannels(SITE).find(m => m.nameAt(ctx.now) === ctx.params.name);
        if (!model) return html(404, "<!doctype html><p>Not found</p>");
        const s = this.showStatus(model, ctx.now);
        return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>${model.nameAt(ctx.now)}</title></head><body>
<main data-channel-id="${model.spec.id}" data-status="${s.status}"><h1>${model.nameAt(ctx.now)}</h1></main></body></html>`);
    }
}
