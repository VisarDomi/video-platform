// A running simulation: the current scenario's engine, the clock, the media,
// the ground-truth log and the per-site state that must survive a restart
// (auth token families, follows). Scenario switches replace the engine; the
// sites read `sim.engine` on every request.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SimClock } from "./clock.js";
import type { ChannelModel, Session } from "./engine/channel.js";
import { LiveEngine } from "./engine/engine.js";
import { Publisher } from "./engine/publisher.js";
import { writeJsonDurable } from "./fsutil.js";
import type { Router } from "./http/server.js";
import type { MediaLibrary } from "./media/library.js";
import type { Scenario, SiteId } from "./scenario/schema.js";
import type { TruthSink } from "./truth/log.js";

export interface SiteModule {
    readonly id: SiteId;
    readonly router: Router;
    /** The identity a client should use for one recording of this session. */
    recordingId(model: ChannelModel, session: Session): string;
    /** Site-specific facts for the control API's state listing. */
    describeChannel?(model: ChannelModel, t: number): Record<string, unknown>;
}

/** Small JSON documents kept durably in the state directory (or in memory). */
export class StateStore {
    private readonly memory = new Map<string, unknown>();
    constructor(readonly dir: string | null) {}

    read<T>(name: string, fallback: T): T {
        if (this.memory.has(name)) return this.memory.get(name) as T;
        let value = fallback;
        if (this.dir) {
            const file = join(this.dir, `${name}.json`);
            if (existsSync(file)) value = JSON.parse(readFileSync(file, "utf8")) as T;
        }
        this.memory.set(name, value);
        return value;
    }

    /** Durable when it returns: written to a temp file, fsynced, renamed. */
    write(name: string, value: unknown): void {
        this.memory.set(name, value);
        if (this.dir) writeJsonDurable(join(this.dir, `${name}.json`), value);
    }
}

export interface SimulationOptions {
    library: MediaLibrary;
    clock: SimClock;
    truth: TruthSink;
    stateDir?: string | null;
    hashBudget?: number;
    /** Publish to the truth log on a timer (off in tests that tick by hand). */
    autoPublish?: boolean;
}

export class Simulation {
    engine!: LiveEngine;
    publisher!: Publisher;
    readonly library: MediaLibrary;
    readonly clock: SimClock;
    readonly truth: TruthSink;
    readonly store: StateStore;
    readonly sites = new Map<SiteId, SiteModule>();
    private readonly autoPublish: boolean;
    private readonly hashBudget: number | undefined;
    private unsubscribe: (() => void) | null = null;

    constructor(options: SimulationOptions) {
        this.library = options.library;
        this.clock = options.clock;
        this.truth = options.truth;
        this.store = new StateStore(options.stateDir ?? null);
        this.autoPublish = options.autoPublish ?? true;
        this.hashBudget = options.hashBudget;
        // Explicit clock moves publish at once, so the log never lags a jump.
        // A new scenario's publisher starts from what is still fetchable; the
        // scenario record in between tells readers where one period ends.
        this.unsubscribe = this.clock.onMove(() => this.publisher?.tick());
    }

    addSite(site: SiteModule): void {
        this.sites.set(site.id, site);
    }

    recordingId(site: SiteId, channel: string, session: Session): string {
        const module = this.sites.get(site);
        const model = this.engine.channel(site, channel);
        return module && model ? module.recordingId(model, session) : session.key;
    }

    /**
     * Makes `scenario` current. The epoch is the scenario's own, else the one
     * given, else now (whole seconds).
     */
    load(scenario: Scenario, options: { epochMs?: number; reason?: "start" | "switch" } = {}): LiveEngine {
        const epochMs = scenario.epoch ?? options.epochMs ?? Math.floor(this.clock.now() / 1000) * 1000;
        const previous = this.publisher;
        previous?.tick();
        previous?.stop();
        this.engine = new LiveEngine(scenario, this.library, this.clock, epochMs);
        this.truth.append({
            type: "scenario", t: this.clock.now(), name: scenario.name, seed: scenario.seed, hash: this.engine.scenarioHash,
            epochMs, reason: options.reason ?? (previous ? "switch" : "start"),
        });
        this.publisher = new Publisher(this.engine, this.library, this.truth, {
            hashBudget: this.hashBudget,
            recordingId: (site, channel, session) => this.recordingId(site, channel, session),
        });
        this.publisher.tick();
        if (this.autoPublish) this.publisher.start();
        return this.engine;
    }

    close(): void {
        this.publisher?.tick();
        this.publisher?.stop();
        this.unsubscribe?.();
        this.truth.close();
    }
}
