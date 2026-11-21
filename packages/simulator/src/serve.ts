// Starting the simulator: one HTTP(S) server per site plus the control API,
// all sharing one Simulation. Used by the CLI and by tests (ephemeral ports).
//
// With a state directory the run survives restarts: the scenario in force,
// its epoch and the clock are persisted (fsync + rename) on every change, as
// are the sites' auth families; the ground-truth log is appended there too.
import { existsSync, readFileSync } from "node:fs";
import type http from "node:http";
import { join } from "node:path";
import { SimClock, type ClockSnapshot } from "./clock.js";
import { controlRouter } from "./control.js";
import { writeJsonDurable } from "./fsutil.js";
import { close, createSiteServer, listen } from "./http/server.js";
import { MediaLibrary } from "./media/library.js";
import { hashHex } from "./rng.js";
import { parseSeconds, validateScenario, type AnySiteId, type Scenario } from "./scenario/schema.js";
import { Simulation } from "./sim.js";
import { createSites } from "./sites/index.js";
import { MemoryTruth, TeeTruth, TruthLog, type RotationOptions, type TruthSink } from "./truth/log.js";

export type PortName = AnySiteId | "control" | "file-host-cdn";

export const DEFAULT_PORTS: Record<PortName, number> = {
    control: 18080, "ts-live": 18081, "ladder-live": 18082, "fmp4-live": 18083,
    "file-host": 18084, "form-host": 18085, "api-host": 18086, "file-host-cdn": 18087,
};

export interface StartOptions {
    /** A scenario object (validated here) or a path to a JSON file. */
    scenario: unknown;
    media: string | MediaLibrary;
    stateDir?: string | null;
    /** Defaults to <stateDir>/truth.jsonl when there is a state directory. */
    truthFile?: string | null;
    /** Also keep the log in memory (tests). */
    memoryTruth?: boolean;
    /** Rotate the log file by size or (simulated) age. */
    truthRotation?: RotationOptions;
    host?: string;
    /** 0 = any free port. Missing entries use 0. */
    ports?: Partial<Record<PortName, number>>;
    tls?: { cert: string; key: string };
    clock?: SimClock;
    clockMode?: "real" | "manual";
    autoPublish?: boolean;
    hashBudget?: number;
}

export interface RunningSimulator {
    sim: Simulation;
    urls: Record<PortName, string>;
    memory: MemoryTruth | null;
    truthFile: string | null;
    close(): Promise<void>;
}

interface PersistedState {
    version: 1;
    /** Hash of the scenario given at start: a different one starts over. */
    startScenarioHash: string;
    scenario: Scenario;
    epochMs: number;
    clock: ClockSnapshot;
}

function loadScenarioInput(input: unknown): unknown {
    if (typeof input !== "string") return input;
    return JSON.parse(readFileSync(input, "utf8"));
}

export async function startSimulator(options: StartOptions): Promise<RunningSimulator> {
    const raw = loadScenarioInput(options.scenario);
    const startScenario = validateScenario(raw);
    const startHash = hashHex(JSON.stringify(startScenario));
    const library = typeof options.media === "string" ? MediaLibrary.load(options.media) : options.media;
    const stateDir = options.stateDir ?? null;
    const stateFile = stateDir ? join(stateDir, "simulator.json") : null;

    let persisted: PersistedState | null = null;
    if (stateFile && existsSync(stateFile)) {
        const p = JSON.parse(readFileSync(stateFile, "utf8")) as PersistedState;
        if (p.version === 1 && p.startScenarioHash === startHash) persisted = p;
    }
    const clock = options.clock
        ?? (persisted ? SimClock.restore(persisted.clock) : new SimClock({ mode: options.clockMode ?? "real" }));

    const truthFile = options.truthFile !== undefined ? options.truthFile : stateDir ? join(stateDir, "truth.jsonl") : null;
    const memory = options.memoryTruth ? new MemoryTruth() : null;
    const sinks: TruthSink[] = [];
    if (truthFile) sinks.push(new TruthLog(truthFile, 1000, options.truthRotation));
    if (memory) sinks.push(memory);
    const truth: TruthSink = sinks.length === 1 ? sinks[0] : new TeeTruth(sinks);

    const sim = new Simulation({ library, clock, truth, stateDir, autoPublish: options.autoPublish, hashBudget: options.hashBudget });
    // A different scenario file starts over: the sites' documents and uploads
    // from the earlier run go too (the truth log keeps growing).
    if (stateFile && existsSync(stateFile) && !persisted) sim.store.clear();
    const scheme = options.tls ? "https" : "http";
    for (const site of createSites(sim, scheme)) sim.addSite(site);
    if (persisted) sim.load(validateScenario(persisted.scenario), { epochMs: persisted.epochMs, reason: "start" });
    else sim.load(startScenario, { reason: "start" });

    const persist = () => {
        if (!stateFile) return;
        const state: PersistedState = { version: 1, startScenarioHash: startHash, scenario: sim.engine.scenario, epochMs: sim.engine.epochMs, clock: sim.clock.snapshot() };
        writeJsonDurable(stateFile, state);
    };
    persist();

    const host = options.host ?? "127.0.0.1";
    const urls = {} as Record<PortName, string>;
    const servers: http.Server[] = [];
    // Listening on every address is no address to connect to: the URLs (and the links a
    // site builds from them) name the loopback one.
    const urlHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
    try {
        for (const [site, module] of sim.sites) {
            for (const { name, router } of [{ name: site as string, router: module.router }, ...(module.extraServers ?? [])]) {
                const server = createSiteServer({ site, router, truth, now: () => sim.clock.now(), tls: options.tls });
                servers.push(server);
                const port = await listen(server, options.ports?.[name as PortName] ?? 0, host);
                urls[name as PortName] = `${scheme}://${urlHost}:${port}`;
                sim.urls[name] = urls[name as PortName];
            }
        }
        const control = createSiteServer({
            site: "control", truth, now: () => sim.clock.now(), tls: options.tls,
            router: controlRouter(sim, { persist, urls: () => urls, truthFile }),
        });
        servers.push(control);
        urls.control = `${scheme}://${urlHost}:${await listen(control, options.ports?.control ?? 0, host)}`;
        sim.urls.control = urls.control;
    } catch (error) {
        await Promise.all(servers.map(s => close(s)));
        await closeSites(sim);
        sim.close();
        throw error;
    }

    return {
        sim, urls, memory, truthFile,
        async close() {
            await Promise.all(servers.map(s => close(s)));
            await closeSites(sim);
            persist();
            sim.close();
        },
    };
}

async function closeSites(sim: Simulation): Promise<void> {
    for (const module of sim.sites.values()) await module.close?.();
}

function parsePorts(value: string | undefined): Partial<Record<PortName, number>> {
    const ports: Partial<Record<PortName, number>> = { ...DEFAULT_PORTS };
    for (const part of (value ?? "").split(",").filter(Boolean)) {
        const [name, port] = part.split("=");
        if (!(name in DEFAULT_PORTS) || !/^\d+$/.test(port ?? "")) throw new Error(`--ports: expected name=port with names ${Object.keys(DEFAULT_PORTS).join(", ")}`);
        ports[name as PortName] = Number(port);
    }
    return ports;
}

/** "500000", "64K", "100M", "2G" -> bytes. */
export function parseSize(value: string): number {
    const m = /^(\d+(?:\.\d+)?)\s*([KMG]?)i?B?$/i.exec(value.trim());
    if (!m) throw new Error(`expected a size like 100M, got "${value}"`);
    return Math.floor(Number(m[1]) * 1024 ** "_KMG".indexOf(m[2].toUpperCase() || "_"));
}

function rotationFromFlags(flags: Map<string, string>): RotationOptions | undefined {
    const maxBytes = flags.get("truth-max-bytes"), maxAge = flags.get("truth-max-age"), keep = flags.get("truth-keep");
    if (!maxBytes && !maxAge) return undefined;
    const ageS = maxAge === undefined ? undefined : parseSeconds(/^\d+(\.\d+)?$/.test(maxAge) ? Number(maxAge) : maxAge);
    if (maxAge !== undefined && ageS === undefined) throw new Error(`--truth-max-age: expected seconds or "1h30m", got "${maxAge}"`);
    return {
        ...(maxBytes ? { maxBytes: parseSize(maxBytes) } : {}),
        ...(ageS !== undefined ? { maxAgeMs: ageS * 1000 } : {}),
        ...(keep ? { keep: Number(keep) } : {}),
    };
}

export async function serveFromCli(flags: Map<string, string>): Promise<void> {
    const scenario = flags.get("scenario");
    const media = flags.get("media");
    if (!scenario || !media) throw new Error("serve needs --scenario <file> and --media <cacheDir>");
    const cert = flags.get("tls-cert"), key = flags.get("tls-key");
    if (Boolean(cert) !== Boolean(key)) throw new Error("--tls-cert and --tls-key go together");
    const clockMode = flags.get("clock");
    if (clockMode && clockMode !== "real" && clockMode !== "manual") throw new Error('--clock is "real" or "manual"');
    const running = await startSimulator({
        scenario, media,
        stateDir: flags.get("state") ?? null,
        host: flags.get("host") ?? "127.0.0.1",
        ports: parsePorts(flags.get("ports")),
        tls: cert && key ? { cert, key } : undefined,
        clockMode: clockMode as "real" | "manual" | undefined,
        truthRotation: rotationFromFlags(flags),
    });
    process.stdout.write(JSON.stringify({ event: "listening", ...running.urls, truthFile: running.truthFile, scenario: running.sim.engine.scenario.name }) + "\n");
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        await running.close();
        process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}
