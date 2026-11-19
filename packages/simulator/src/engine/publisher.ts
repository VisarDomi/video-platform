// Writes what the engine publishes into the ground-truth log as time passes:
// one record per segment, edge and rendition slot, the moment it appears on
// the edge, with how long it stays listed and fetchable.
import type { MediaLibrary } from "../media/library.js";
import { sha256 } from "../rng.js";
import type { SiteId } from "../scenario/schema.js";
import type { TruthSink } from "../truth/log.js";
import type { Session } from "./channel.js";
import type { LiveEngine } from "./engine.js";

export interface PublisherOptions {
    /** Hash at most this many segments per tick; the rest get sha256 null. */
    hashBudget?: number;
    recordingId: (site: SiteId, channel: string, session: Session) => string;
}

export class Publisher {
    private through: number;
    private readonly seenSessions = new Set<string>();
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly engine: LiveEngine,
        private readonly library: MediaLibrary,
        private readonly sink: TruthSink,
        private readonly options: PublisherOptions,
    ) {
        // Whatever is still fetchable when the server starts counts as published now.
        this.through = engine.now() - engine.scenario.segmentRetentionS * 1000;
    }

    start(intervalMs = 250): void {
        this.stop();
        this.timer = setInterval(() => this.tick(), intervalMs);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    tick(now = this.engine.now()): number {
        if (now <= this.through) return 0;
        const from = this.through;
        let written = 0, hashed = 0;
        const budget = this.options.hashBudget ?? 500;
        for (const site of this.engine.sites()) {
            for (const model of this.engine.siteChannels(site)) {
                const maxLag = Math.max(...model.edges.map(e => e.lagMs));
                const sessions = model.sessionsBetween(from - maxLag - model.targetDurationS * 2000, now);
                for (const session of sessions) {
                    if (session.startMs > now) continue;
                    const sessionId = `${site}/${model.spec.id}/${session.key}`;
                    if (!this.seenSessions.has(sessionId)) {
                        this.seenSessions.add(sessionId);
                        this.sink.append({
                            type: "session", t: now, site, channel: model.spec.id, session: session.key, index: session.index,
                            startMs: session.startMs, endMs: session.endMs, source: model.source,
                            recordingId: this.options.recordingId(site, model.spec.id, session),
                        });
                    }
                    for (const edge of model.edges) {
                        const kLo = Math.max(0, model.indexAtOrAfter(session, from - edge.lagMs) - 1);
                        const kHi = model.lastCompleteBy(session, now - edge.lagMs);
                        for (let k = kLo; k <= kHi; k++) {
                            const publishedAt = model.publishedAtMs(session, edge, k);
                            if (publishedAt <= from || publishedAt > now || model.isSkipped(session, edge, k)) continue;
                            const src = model.srcOf(session, k);
                            const seq = model.sequenceOf(session, edge, k);
                            const listedUntil = model.listedUntilMs(session, edge, k);
                            const pdt = new Date(model.segmentStartMs(session, k) + edge.pdtSkewMs).toISOString();
                            for (let tier = 0; tier < model.renditions.length; tier++) {
                                const served = model.servedAs(session, edge, k, tier);
                                const rendition = model.renditions[served.rendition];
                                let digest: string | null = null, bytes: number | null = null;
                                if (hashed < budget) {
                                    const data = this.library.segmentBytes({
                                        source: model.source, rendition: rendition.id, index: src.srcIndex, loop: src.loop, damage: served.damage,
                                    });
                                    digest = sha256(data);
                                    bytes = data.length;
                                    hashed++;
                                }
                                this.sink.append({
                                    type: "publish", t: now, site, channel: model.spec.id, session: session.key, edge: edge.id,
                                    tier: model.renditions[tier].id, rendition: rendition.id, k, seq, pdt,
                                    durationS: rendition.segments[src.srcIndex].durationS,
                                    // Whole milliseconds, rounded up: the first instant it is
                                    // listed, and the first it no longer is.
                                    publishedAt: Math.ceil(publishedAt),
                                    listedUntil: Number.isFinite(listedUntil) ? Math.ceil(listedUntil) : null,
                                    fetchableUntil: Math.ceil(publishedAt + model.retentionMs),
                                    srcSha256: rendition.segments[src.srcIndex].sha256, srcIndex: src.srcIndex, loop: src.loop,
                                    damage: served.damage, sha256: digest, bytes,
                                });
                                written++;
                            }
                        }
                    }
                }
            }
        }
        this.through = now;
        return written;
    }
}
