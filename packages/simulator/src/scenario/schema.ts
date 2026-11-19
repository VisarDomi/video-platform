// Scenario files: which channels each simulated site carries, when they are
// live, and a timeline of faults. Validation is strict: an unknown key is an
// error, so a typo never silently disables a fault.
//
// Times are seconds from the scenario epoch (or from each session's start
// when a fault says "scope": "session"). A time may also be written as a
// string such as "90s", "15m", "1h30m".

export const SITE_IDS = ["ts-live", "ladder-live", "fmp4-live"] as const;
export type SiteId = typeof SITE_IDS[number];

export type Schedule =
    | { always: true }
    | { sessions: Array<{ start: number; end: number | null }> }
    | { cycle: { periodS: number; onlineS: number; offsetS: number } };

export interface EdgeSpec {
    id: string;
    lagMs?: number;
    pdtSkewMs?: number;
    firstSequence?: number;
}

export type DamageKind = "single-frame" | "zero-byte" | "zero-size-sample" | "truncated";
export type FaultScope = "scenario" | "session";

interface FaultBase { scope: FaultScope; edge?: string }
interface Window { at: number; until: number }

export type ChannelFault =
    | FaultBase & Window & { type: "playlistStatus"; status: number; target: "master" | "media" | "any"; ratio?: number }
    | FaultBase & Window & { type: "segmentStatus"; status: number; ratio?: number }
    | FaultBase & { type: "skip"; at: number; count: number }
    | FaultBase & { type: "restart"; at: number; value: number }
    | FaultBase & Window & { type: "damage"; kind: DamageKind; every: number }
    | FaultBase & Window & { type: "codecChange" }
    | FaultBase & Window & { type: "edgeOutage"; status: number | "reset" }
    | FaultBase & Window & { type: "stalePlaylist"; staleByS?: number }
    | FaultBase & { type: "streamEnd"; at: number }
    | FaultBase & Window & { type: "showState"; state: "private" | "group" }
    | FaultBase & Window & { type: "paid" };

export type SiteFault =
    | Window & { type: "apiStatus"; status: number | "malformed" | "empty"; api?: string }
    | { type: "tokenRevoke"; at: number }
    | Window & { type: "refreshStatus"; status: number; errorCode?: string }
    | { type: "obfuscationKey"; at: number; keyId: string };

export interface ChannelSpec {
    id: string;
    name: string;
    source?: string;
    schedule: Schedule;
    window?: number;
    endlistS?: number;
    startPosition?: number;
    edges?: EdgeSpec[];
    faults: ChannelFault[];
    renames: Array<{ at: number; name: string }>;
    /** ts-live: serve the media playlist at the master URL. */
    mediaAsMaster?: boolean;
    /** fmp4-live: encode segment URIs. */
    obfuscated?: boolean;
}

export interface Account {
    username: string;
    password: string;
    accountId: string;
    follows?: string[];
}

export interface SiteSpec {
    channels: ChannelSpec[];
    faults: SiteFault[];
    // ts-live
    accounts?: Account[];
    streamTokenTtlS?: number;
    sessionTokenTtlS?: number;
    refreshTokenTtlS?: number;
    reuseRevokesFamily?: boolean;
    extraRecords?: boolean;
    // ladder-live
    pageSize?: number;
    endMaster?: "403" | "empty";
    requireOrigin?: boolean;
    // fmp4-live
    edges?: string[];
    obfuscation?: { keys: Record<string, string>; keyId: string };
}

export interface Scenario {
    name: string;
    description?: string;
    seed: string;
    /** Epoch milliseconds, or null for "when loaded". */
    epoch: number | null;
    segmentRetentionS: number;
    sites: Partial<Record<SiteId, SiteSpec>>;
}

export class ScenarioError extends Error {
    constructor(readonly problems: string[]) {
        super(`invalid scenario:\n  ${problems.join("\n  ")}`);
    }
}

// ---- a small strict validator ----

type Check<T> = (value: unknown, path: string, problems: string[]) => T | undefined;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(pattern?: RegExp, what = "a string"): Check<string> {
    return (v, path, problems) => {
        if (typeof v !== "string" || v.length === 0) { problems.push(`${path}: expected ${what}`); return undefined; }
        if (pattern && !pattern.test(v)) { problems.push(`${path}: "${v}" is not ${what}`); return undefined; }
        return v;
    };
}

function num(min: number, max = Infinity, integer = false): Check<number> {
    return (v, path, problems) => {
        if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
            problems.push(`${path}: expected ${integer ? "an integer" : "a number"} in [${min}, ${max}]`);
            return undefined;
        }
        return v;
    };
}

const bool: Check<boolean> = (v, path, problems) => {
    if (typeof v !== "boolean") { problems.push(`${path}: expected true or false`); return undefined; }
    return v;
};

function oneOf<T extends string | number>(...values: T[]): Check<T> {
    return (v, path, problems) => {
        if (!values.includes(v as T)) { problems.push(`${path}: expected one of ${values.map(x => JSON.stringify(x)).join(", ")}`); return undefined; }
        return v as T;
    };
}

export function parseSeconds(v: unknown): number | undefined {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v !== "string") return undefined;
    const m = /^\s*(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?\s*$/.exec(v);
    if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
    return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const seconds: Check<number> = (v, path, problems) => {
    const s = parseSeconds(v);
    if (s === undefined) problems.push(`${path}: expected seconds (a number, or a string like "90s", "15m", "1h30m")`);
    return s;
};

function list<T>(item: Check<T>): Check<T[]> {
    return (v, path, problems) => {
        if (!Array.isArray(v)) { problems.push(`${path}: expected an array`); return undefined; }
        const out: T[] = [];
        v.forEach((x, i) => { const r = item(x, `${path}[${i}]`, problems); if (r !== undefined) out.push(r); });
        return out;
    };
}

type Fields = Record<string, { check: Check<any>; optional?: boolean; default?: unknown }>;
const req = (check: Check<any>) => ({ check });
const opt = (check: Check<any>, def?: unknown) => ({ check, optional: true, default: def });

function object(fields: Fields): Check<Record<string, any>> {
    return (v, path, problems) => {
        if (!isObject(v)) { problems.push(`${path}: expected an object`); return undefined; }
        const out: Record<string, any> = {};
        for (const key of Object.keys(v)) {
            if (!(key in fields)) problems.push(`${path}: unknown key "${key}"`);
        }
        for (const [key, spec] of Object.entries(fields)) {
            if (v[key] === undefined) {
                if (!spec.optional) problems.push(`${path}: missing "${key}"`);
                else if (spec.default !== undefined) out[key] = spec.default;
                continue;
            }
            const r = spec.check(v[key], `${path}.${key}`, problems);
            if (r !== undefined) out[key] = r;
        }
        return out;
    };
}

const statusCode = oneOf(401, 403, 404, 410, 429, 500, 502, 503, 504);
const id = str(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "an id (letters, digits, _ . -)");
const window = { at: req(seconds), until: req(seconds) };
const base = { scope: opt(oneOf("scenario", "session"), "scenario"), edge: opt(id) };

const faultShapes: Record<string, Fields> = {
    playlistStatus: { ...base, ...window, status: req(statusCode), target: opt(oneOf("master", "media", "any"), "media"), ratio: opt(num(0, 1)) },
    segmentStatus: { ...base, ...window, status: req(statusCode), ratio: opt(num(0, 1)) },
    skip: { ...base, at: req(seconds), count: req(num(1, 10000, true)) },
    restart: { ...base, at: req(seconds), value: opt(num(0, 2 ** 31, true), 0) },
    damage: { ...base, ...window, kind: req(oneOf("single-frame", "zero-byte", "zero-size-sample", "truncated")), every: opt(num(1, 1000, true), 1) },
    codecChange: { ...base, ...window },
    edgeOutage: { ...base, ...window, status: req((v, p, pr) => v === "reset" ? "reset" : statusCode(v, p, pr)) },
    stalePlaylist: { ...base, ...window, staleByS: opt(num(0.001, 3600)) },
    streamEnd: { ...base, at: req(seconds) },
    showState: { ...base, ...window, state: req(oneOf("private", "group")) },
    paid: { ...base, ...window },
};
const faultsBySite: Record<SiteId, string[]> = {
    "ts-live": ["playlistStatus", "segmentStatus", "skip", "restart", "damage", "codecChange", "edgeOutage", "stalePlaylist", "streamEnd"],
    "ladder-live": ["playlistStatus", "segmentStatus", "skip", "restart", "damage", "codecChange", "edgeOutage", "stalePlaylist", "streamEnd", "paid"],
    "fmp4-live": ["playlistStatus", "segmentStatus", "skip", "restart", "damage", "codecChange", "edgeOutage", "stalePlaylist", "streamEnd", "showState"],
};

const siteFaultShapes: Record<string, Fields> = {
    apiStatus: { ...window, status: req((v, p, pr) => v === "malformed" || v === "empty" ? v : statusCode(v, p, pr)), api: opt(id) },
    tokenRevoke: { at: req(seconds) },
    refreshStatus: { ...window, status: req(statusCode), errorCode: opt(str(/^[A-Z_]+$/, "an error code")) },
    obfuscationKey: { at: req(seconds), keyId: req(id) },
};
const siteFaultsBySite: Record<SiteId, string[]> = {
    "ts-live": ["apiStatus", "tokenRevoke", "refreshStatus"],
    "ladder-live": ["apiStatus"],
    "fmp4-live": ["apiStatus", "obfuscationKey"],
};

function tagged(shapes: Record<string, Fields>, allowed: string[], what: string): Check<any> {
    return (v, path, problems) => {
        if (!isObject(v) || typeof v.type !== "string") { problems.push(`${path}: expected a ${what} with a "type"`); return undefined; }
        if (!allowed.includes(v.type)) {
            problems.push(`${path}: ${what} type "${v.type}" is not one of ${allowed.join(", ")}`);
            return undefined;
        }
        const { type, ...rest } = v;
        const out = object(shapes[type])(rest, path, problems);
        if (out && "until" in out && "at" in out && out.until <= out.at) problems.push(`${path}: "until" must be after "at"`);
        return out ? { type, ...out } : undefined;
    };
}

const schedule: Check<Schedule> = (v, path, problems) => {
    if (!isObject(v)) { problems.push(`${path}: expected a schedule object`); return undefined; }
    const keys = Object.keys(v);
    if (keys.length !== 1) { problems.push(`${path}: a schedule has exactly one of "always", "sessions", "cycle"`); return undefined; }
    if (keys[0] === "always") {
        if (v.always !== true) problems.push(`${path}.always: expected true`);
        return { always: true };
    }
    if (keys[0] === "sessions") {
        const sessions = list(object({ start: req(seconds), end: opt((x, p, pr) => x === null ? null : seconds(x, p, pr)) }))(v.sessions, `${path}.sessions`, problems);
        if (!sessions) return undefined;
        const normalized = sessions.map(s => ({ start: s.start as number, end: (s.end ?? null) as number | null }));
        normalized.forEach((s, i) => {
            if (s.end !== null && s.end <= s.start) problems.push(`${path}.sessions[${i}]: "end" must be after "start"`);
            const next = normalized[i + 1];
            if (next && (s.end === null || next.start < s.end)) problems.push(`${path}.sessions[${i + 1}]: sessions must be in order and not overlap`);
        });
        return { sessions: normalized };
    }
    if (keys[0] === "cycle") {
        const c = object({ periodS: req(num(10)), onlineS: req(num(1)), offsetS: opt(num(0), 0) })(v.cycle, `${path}.cycle`, problems);
        if (c && c.onlineS >= c.periodS) problems.push(`${path}.cycle: "onlineS" must be shorter than "periodS"`);
        return c ? { cycle: c as { periodS: number; onlineS: number; offsetS: number } } : undefined;
    }
    problems.push(`${path}: unknown schedule kind "${keys[0]}"`);
    return undefined;
};

const edge = object({ id: req(id), lagMs: opt(num(0, 60000)), pdtSkewMs: opt(num(-60000, 60000)), firstSequence: opt(num(0, 2 ** 31, true)) });

function channel(site: SiteId): Check<ChannelSpec> {
    const fields: Fields = {
        id: req(site === "ts-live" ? id : str(/^[1-9][0-9]{0,15}$/, "a numeric id")),
        name: req(str(/^[A-Za-z0-9_.-]{1,64}$/, "a name (letters, digits, _ . -)")),
        source: opt(id),
        schedule: req(schedule),
        window: opt(num(2, 30, true)),
        endlistS: opt(num(0, 3600)),
        startPosition: opt(num(0, 1e9, true)),
        edges: opt(list(edge)),
        faults: opt(list(tagged(faultShapes, faultsBySite[site], `${site} fault`)), []),
        renames: opt(list(object({ at: req(seconds), name: req(str(/^[A-Za-z0-9_.-]{1,64}$/, "a name")) })), []),
    };
    if (site === "ts-live") fields.mediaAsMaster = opt(bool);
    if (site === "fmp4-live") fields.obfuscated = opt(bool);
    return object(fields) as Check<ChannelSpec>;
}

function siteSpec(site: SiteId): Check<SiteSpec> {
    const fields: Fields = {
        channels: req(list(channel(site))),
        faults: opt(list(tagged(siteFaultShapes, siteFaultsBySite[site], `${site} site fault`)), []),
    };
    if (site === "ts-live") {
        Object.assign(fields, {
            accounts: req(list(object({
                username: req(str()), password: req(str()), accountId: req(id), follows: opt(list(id)),
            }))),
            streamTokenTtlS: opt(num(1, 3600)),
            sessionTokenTtlS: opt(num(1, 86400 * 7)),
            refreshTokenTtlS: opt(num(1, 86400 * 365)),
            reuseRevokesFamily: opt(bool),
            extraRecords: opt(bool),
        });
    }
    if (site === "ladder-live") {
        Object.assign(fields, { pageSize: opt(num(1, 1000, true)), endMaster: opt(oneOf("403", "empty")), requireOrigin: opt(bool) });
    }
    if (site === "fmp4-live") {
        Object.assign(fields, {
            edges: opt(list(id)),
            obfuscation: opt(object({
                keys: req((v: unknown, p: string, pr: string[]) => {
                    if (!isObject(v) || Object.keys(v).length === 0) { pr.push(`${p}: expected an object of key id -> secret`); return undefined; }
                    for (const [k, s] of Object.entries(v)) { id(k, `${p} key`, pr); str()(s, `${p}.${k}`, pr); }
                    return v;
                }),
                keyId: req(id),
            })),
        });
    }
    return object(fields) as Check<SiteSpec>;
}

const scenarioCheck = object({
    name: req(str()),
    description: opt(str()),
    seed: req(str()),
    epoch: opt((v, p, pr) => {
        if (v === null) return null;
        const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
        if (!Number.isFinite(ms)) { pr.push(`${p}: expected an ISO time, epoch milliseconds or null`); return undefined; }
        return ms;
    }, null),
    segmentRetentionS: opt(num(1, 86400), 120),
    sites: req(object(Object.fromEntries(SITE_IDS.map(s => [s, opt(siteSpec(s))])))),
});

export function validateScenario(input: unknown): Scenario {
    const problems: string[] = [];
    const out = scenarioCheck(input, "scenario", problems) as Scenario | undefined;
    if (out) {
        for (const site of SITE_IDS) {
            const spec = out.sites[site];
            if (!spec) continue;
            const seen = new Set<string>();
            spec.channels.forEach((c, i) => {
                if (seen.has(c.id)) problems.push(`scenario.sites.${site}.channels[${i}]: duplicate id "${c.id}"`);
                seen.add(c.id);
                const edgeIds = new Set((c.edges ?? []).map(e => e.id));
                if (edgeIds.size !== (c.edges ?? []).length) problems.push(`scenario.sites.${site}.channels[${i}].edges: duplicate edge id`);
                const known = c.edges ? edgeIds : new Set(site === "fmp4-live" ? spec.edges ?? ["a", "b", "c"] : ["a"]);
                c.faults.forEach((f, j) => {
                    if (f.edge !== undefined && !known.has(f.edge)) {
                        problems.push(`scenario.sites.${site}.channels[${i}].faults[${j}]: unknown edge "${f.edge}" (edges: ${[...known].join(", ")})`);
                    }
                });
            });
            if (site === "fmp4-live" && spec.obfuscation && !(spec.obfuscation.keyId in spec.obfuscation.keys)) {
                problems.push(`scenario.sites.fmp4-live.obfuscation.keyId: "${spec.obfuscation.keyId}" is not in keys`);
            }
            for (const f of spec.faults) {
                if (f.type === "obfuscationKey" && !(spec.obfuscation && f.keyId in spec.obfuscation.keys)) {
                    problems.push(`scenario.sites.${site}.faults: obfuscationKey "${f.keyId}" is not in obfuscation.keys`);
                }
            }
            if (site === "ts-live") {
                const accounts = new Set((spec.accounts ?? []).map(a => a.username));
                if (accounts.size !== (spec.accounts ?? []).length) problems.push(`scenario.sites.ts-live.accounts: duplicate username`);
            }
        }
        if (Object.keys(out.sites).length === 0) problems.push("scenario.sites: no site configured");
    }
    if (problems.length > 0 || !out) throw new ScenarioError(problems);
    return out;
}
