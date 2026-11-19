// The control API (its own port): inspect state, load or switch a scenario,
// move the clock. Every change is persisted before it is acknowledged.
import { json, Router, type Reply, type RequestContext } from "./http/server.js";
import { ScenarioError, validateScenario } from "./scenario/schema.js";
import type { Simulation } from "./sim.js";

export interface ControlHooks {
    /** Persist after a change (scenario, epoch, clock). */
    persist(): void;
    urls(): Record<string, string>;
    truthFile: string | null;
}

export function controlRouter(sim: Simulation, hooks: ControlHooks): Router {
    const r = new Router();
    r.get("/health", () => json(200, { ok: true }, { kind: "control" }));
    r.get("/state", ctx => json(200, describe(sim, hooks, ctx.now), { kind: "control" }));
    r.post("/scenario", async ctx => {
        let scenario;
        try {
            scenario = validateScenario(await ctx.json());
        } catch (error) {
            if (error instanceof ScenarioError) return json(400, { error: "invalid scenario", problems: error.problems }, { kind: "control" });
            throw error;
        }
        const keepEpoch = ctx.url.searchParams.get("epoch") === "keep";
        sim.load(scenario, { epochMs: keepEpoch ? sim.engine.epochMs : undefined, reason: "switch" });
        hooks.persist();
        return json(200, describe(sim, hooks, sim.clock.now()), { kind: "control" });
    });
    r.post("/clock/advance", async ctx => clockChange(ctx, async () => {
        const body = await ctx.json<{ ms?: number; s?: number }>();
        const ms = body.ms ?? (body.s !== undefined ? body.s * 1000 : NaN);
        sim.clock.advance(ms);
    }));
    r.post("/clock/set", async ctx => clockChange(ctx, async () => {
        const body = await ctx.json<{ at?: string | number }>();
        const at = typeof body.at === "string" ? Date.parse(body.at) : Number(body.at);
        sim.clock.set(at);
    }));
    r.post("/clock/mode", async ctx => clockChange(ctx, async () => {
        const body = await ctx.json<{ mode?: string }>();
        if (body.mode !== "real" && body.mode !== "manual") throw new RangeError('mode is "real" or "manual"');
        sim.clock.setMode(body.mode);
    }));

    // Site actions, e.g. remove a destination's video now or sign every session out.
    r.post("/sites/:site/:action", async ctx => {
        const module = sim.sites.get(ctx.params.site as never);
        if (!module?.action) return json(404, { error: "no such site action" }, { kind: "control" });
        let body: Record<string, unknown> = {};
        const raw = (await ctx.body()).toString();
        if (raw.trim()) {
            try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid JSON body" }, { kind: "control" }); }
        }
        try {
            const result = await module.action(ctx.params.action, body, sim.clock.now());
            return json(200, result ?? { ok: true }, { kind: "control" });
        } catch (error) {
            if (error instanceof RangeError) return json(400, { error: error.message }, { kind: "control" });
            throw error;
        }
    });

    async function clockChange(_ctx: RequestContext, change: () => Promise<void>): Promise<Reply> {
        try {
            await change();
        } catch (error) {
            if (error instanceof RangeError) return json(400, { error: error.message }, { kind: "control" });
            throw error;
        }
        hooks.persist();
        const now = sim.clock.now();
        return json(200, { now, iso: new Date(now).toISOString(), mode: sim.clock.mode }, { kind: "control" });
    }
    return r;
}

export function describe(sim: Simulation, hooks: ControlHooks, now: number) {
    const engine = sim.engine;
    const sites: Record<string, unknown> = {};
    for (const site of engine.sites()) {
        const module = sim.sites.get(site);
        sites[site] = {
            url: hooks.urls()[site] ?? null,
            channels: engine.siteChannels(site).map(model => {
                const session = model.sessionAt(now);
                return {
                    id: model.spec.id, name: model.nameAt(now), source: model.source, online: session !== null,
                    session: session ? { key: session.key, index: session.index, startMs: session.startMs, endMs: session.endMs, recordingId: module?.recordingId?.(model, session) ?? session.key } : null,
                    edges: model.edges.map(edge => {
                        const w = session ? model.window(session, edge, now) : null;
                        return { id: edge.id, lagMs: edge.lagMs, pdtSkewMs: edge.pdtSkewMs, mediaSequence: w?.mediaSequence ?? null, segments: w?.entries.length ?? 0 };
                    }),
                    ...(module?.describeChannel?.(model, now) ?? {}),
                };
            }),
        };
    }
    for (const [id, module] of sim.sites) {
        if (sites[id] !== undefined || !module.describe) continue;
        const described = module.describe(now);
        if (described) sites[id] = { url: hooks.urls()[id] ?? null, ...described };
    }
    return {
        scenario: { name: engine.scenario.name, seed: engine.seed, hash: engine.scenarioHash, epochMs: engine.epochMs, epoch: new Date(engine.epochMs).toISOString() },
        clock: { now, iso: new Date(now).toISOString(), mode: sim.clock.mode },
        media: sim.library.ids(),
        truthFile: hooks.truthFile,
        urls: hooks.urls(),
        sites,
    };
}
