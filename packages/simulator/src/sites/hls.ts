// HLS pieces shared by the simulated sites: playlist text, the request-time
// faults every playlist and segment goes through, and segment responses.
import type { ChannelModel, Edge, PlaylistWindow, Session, WindowEntry } from "../engine/channel.js";
import type { MediaLibrary } from "../media/library.js";
import type { RenditionManifest } from "../media/manifest.js";
import { json, type Reply } from "../http/server.js";

export interface Variant {
    rendition: RenditionManifest;
    uri: string;
    name?: string;
}

/** A master playlist: one EXT-X-STREAM-INF per variant, in the given order. */
export function masterPlaylist(variants: Variant[], headerTags: string[] = []): string {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS", ...headerTags];
    for (const v of variants) {
        const r = v.rendition;
        const attrs = [
            `BANDWIDTH=${r.bandwidth}`, `AVERAGE-BANDWIDTH=${r.averageBandwidth}`, `RESOLUTION=${r.width}x${r.height}`,
            `CODECS="${r.codecs}"`, ...(r.frameRate ? [`FRAME-RATE=${r.frameRate.toFixed(3)}`] : []),
            ...(v.name ? [`NAME="${v.name}"`] : []),
        ];
        lines.push(`#EXT-X-STREAM-INF:${attrs.join(",")}`, v.uri);
    }
    return lines.join("\n") + "\n";
}

export interface MediaPlaylistOptions {
    format: "ts" | "fmp4";
    uri: (entry: WindowEntry) => string;
    /** fMP4: the init segment URI for a rendition index of the group. */
    mapUri?: (rendition: number) => string;
    /** Replaces the URI line of an entry with these lines (obfuscation). */
    entryLines?: (entry: WindowEntry, uri: string) => string[];
    headerTags?: string[];
}

export function mediaPlaylist(model: ChannelModel, w: PlaylistWindow, options: MediaPlaylistOptions): string {
    const lines = [
        "#EXTM3U",
        `#EXT-X-VERSION:${options.format === "fmp4" ? 7 : 3}`,
        `#EXT-X-TARGETDURATION:${model.targetDurationS}`,
        `#EXT-X-MEDIA-SEQUENCE:${w.mediaSequence}`,
        ...(options.headerTags ?? []),
    ];
    let map: number | null = null;
    for (const e of w.entries) {
        if (options.format === "fmp4" && options.mapUri && e.rendition !== map) {
            lines.push(`#EXT-X-MAP:URI="${options.mapUri(e.rendition)}"`);
            map = e.rendition;
        }
        lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(e.pdtMs).toISOString()}`);
        lines.push(`#EXTINF:${e.durationS.toFixed(3)},`);
        const uri = options.uri(e);
        lines.push(...(options.entryLines ? options.entryLines(e, uri) : [uri]));
    }
    if (w.ended) lines.push("#EXT-X-ENDLIST");
    return lines.join("\n") + "\n";
}

export interface FaultContext {
    model: ChannelModel;
    session: Session;
    edge: Edge;
    t: number;
}

const statusBody = (status: number) => json(status, { error: `simulated ${status}` });

/** Edge outages and scripted playlist statuses, or null to serve normally. */
export function playlistFault({ model, session, edge, t }: FaultContext, target: "master" | "media"): Reply | null {
    const outage = model.active(session, "edgeOutage", t, edge.id)[0];
    if (outage) return outage.fault.status === "reset" ? { status: "reset" } : statusBody(outage.fault.status);
    const scripted = model.active(session, "playlistStatus", t, edge.id)
        .find(f => f.fault.target === "any" || f.fault.target === target);
    return scripted ? statusBody(scripted.fault.status) : null;
}

/** Fields for the response record of a playlist. */
export function playlistLog(model: ChannelModel, w: PlaylistWindow, tier: number): Reply["log"] {
    return {
        channel: model.spec.id, session: w.session.key, edge: w.edge.id, tier: model.renditions[tier]?.id,
        mediaSequence: w.mediaSequence, count: w.entries.length, ended: w.ended,
        ...(w.staleAt !== null ? { stale: true } : {}),
    };
}

/** A segment response with every request-time fault applied. */
export function segmentReply(library: MediaLibrary, fc: FaultContext, tier: number, k: number): Reply {
    const { model, session, edge, t } = fc;
    const log = { channel: model.spec.id, session: session.key, edge: edge.id, tier: model.renditions[tier]?.id, k };
    if (tier < 0 || tier >= model.renditions.length || !Number.isInteger(k)) return json(404, { error: "no such segment" }, { kind: "segment", log });
    const outage = model.active(session, "edgeOutage", t, edge.id)[0];
    if (outage) return outage.fault.status === "reset" ? { status: "reset", kind: "segment", log } : { ...statusBody(outage.fault.status), kind: "segment", log };
    const scripted = model.active(session, "segmentStatus", t, edge.id)[0];
    if (scripted) return { ...statusBody(scripted.fault.status), kind: "segment", log };
    const availability = model.segmentAvailability(session, edge, k, t);
    if (availability !== "ok") return json(404, { error: `segment ${availability}` }, { kind: "segment", log: { ...log, reason: availability } });
    const src = model.srcOf(session, k);
    const served = model.servedAs(session, edge, k, tier);
    const rendition = model.renditions[served.rendition];
    const body = library.segmentBytes({ source: model.source, rendition: rendition.id, index: src.srcIndex, loop: src.loop, damage: served.damage });
    return {
        status: 200, body, kind: "segment", hashBody: true,
        headers: { "content-type": rendition.format === "ts" ? "video/mp2t" : "video/iso.segment" },
        log: { ...log, seq: model.sequenceOf(session, edge, k), ...(served.damage ? { reason: `damage:${served.damage}` } : {}) },
    };
}

export function initReply(library: MediaLibrary, model: ChannelModel, rendition: number, log: Reply["log"]): Reply {
    const r = model.renditions[rendition];
    if (!r || !r.init) return json(404, { error: "no such init segment" }, { kind: "init", log });
    return { status: 200, body: library.initBytes(model.source, r.id), kind: "init", hashBody: true, headers: { "content-type": "video/mp4" }, log };
}
