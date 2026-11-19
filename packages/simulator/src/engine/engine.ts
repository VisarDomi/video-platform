// The live engine: every channel of every simulated site for one scenario.
import type { Clock } from "../clock.js";
import type { MediaLibrary } from "../media/library.js";
import { hashHex, intBetween } from "../rng.js";
import { SITE_IDS, type Scenario, type SiteFault, type SiteId, type SiteSpec } from "../scenario/schema.js";
import { ChannelModel } from "./channel.js";

export interface SiteDefaults {
    /** Media group the site serves (see the manifest's groups). */
    group: string;
    window: number;
    endlistS: number;
    edges: string[];
}

export function siteDefaults(site: SiteId, spec: SiteSpec): SiteDefaults {
    switch (site) {
        case "ts-live": return { group: "ts", window: 6, endlistS: 6, edges: ["a"] };
        case "ladder-live": return { group: "ladder", window: 4, endlistS: 0, edges: ["a"] };
        case "fmp4-live": return { group: "fmp4", window: 3, endlistS: 6, edges: spec.edges ?? ["a", "b", "c"] };
    }
}

export class LiveEngine {
    readonly channels = new Map<SiteId, Map<string, ChannelModel>>();
    /** A short fingerprint of the scenario, logged with every load. */
    readonly scenarioHash: string;

    constructor(
        readonly scenario: Scenario,
        readonly library: MediaLibrary,
        readonly clock: Clock,
        readonly epochMs: number,
    ) {
        this.scenarioHash = hashHex(JSON.stringify(scenario)).slice(0, 16);
        const sources = library.ids();
        for (const site of SITE_IDS) {
            const spec = scenario.sites[site];
            if (!spec) continue;
            const defaults = siteDefaults(site, spec);
            const models = new Map<string, ChannelModel>();
            for (const channel of spec.channels) {
                const source = channel.source ?? sources[intBetween(0, sources.length - 1, scenario.seed, site, channel.id, "source")];
                if (!library.sources.has(source)) throw new Error(`${site} channel ${channel.id}: media source "${source}" is not in the cache (have: ${sources.join(", ")})`);
                models.set(channel.id, new ChannelModel(site, channel, scenario.seed, epochMs, source, defaults.group,
                    library, defaults, scenario.segmentRetentionS * 1000));
            }
            this.channels.set(site, models);
        }
    }

    get seed(): string { return this.scenario.seed; }

    now(): number { return this.clock.now(); }

    sites(): SiteId[] {
        return [...this.channels.keys()];
    }

    siteSpec(site: SiteId): SiteSpec | undefined {
        return this.scenario.sites[site];
    }

    siteChannels(site: SiteId): ChannelModel[] {
        return [...(this.channels.get(site)?.values() ?? [])];
    }

    channel(site: SiteId, id: string): ChannelModel | undefined {
        return this.channels.get(site)?.get(id);
    }

    /** Site-level faults of `type` active at `t`. */
    siteFaults<T extends SiteFault["type"]>(site: SiteId, type: T, t: number): Array<Extract<SiteFault, { type: T }>> {
        const spec = this.scenario.sites[site];
        if (!spec) return [];
        return spec.faults.filter(f => {
            if (f.type !== type) return false;
            const from = this.epochMs + f.at * 1000;
            const until = "until" in f ? this.epochMs + f.until * 1000 : Infinity;
            return from <= t && t < until;
        }) as Array<Extract<SiteFault, { type: T }>>;
    }

    /** The latest site fault of `type` that started at or before `t`. */
    lastSiteEvent<T extends SiteFault["type"]>(site: SiteId, type: T, t: number): Extract<SiteFault, { type: T }> | undefined {
        const spec = this.scenario.sites[site];
        const started = (spec?.faults ?? []).filter(f => f.type === type && this.epochMs + f.at * 1000 <= t);
        started.sort((a, b) => a.at - b.at);
        return started[started.length - 1] as Extract<SiteFault, { type: T }> | undefined;
    }
}
