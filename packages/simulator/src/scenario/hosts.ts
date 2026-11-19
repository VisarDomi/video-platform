// Scenario blocks for the file host and the two upload destinations. Like the
// live sites they are validated strictly; unlike them they have no channels:
// their state (files, accounts, uploaded videos) is data, and the scenario
// scripts how the site treats it over time (processing delays, removals,
// forced logouts, cache windows, notices, quotas, transfer stalls).
import { bool, list, num, object, oneOf, opt, req, seconds, str, tagged, type Check, type Fields } from "./check.js";
import type { Scenario } from "./schema.js";

// ---- shared ----

/** Picks videos for a rule; every field given must match (none = every video). */
export interface VideoSelector {
    /** The n-th video the account created on this site (1-based). */
    nth?: number;
    /** A case-insensitive regular expression on the title as submitted. */
    titleMatches?: string;
    /** The uploaded media is shorter than this. */
    shorterThanS?: number;
    account?: string;
}

export interface ProcessingRule extends VideoSelector {
    processingS?: number;
    /** "failed" shows an error row (form-host) or status failed (api-host). */
    outcome?: "ready" | "failed";
    /** A failed video that publishes after all, this long after it failed. */
    recoverAfterS?: number;
}

export interface RemovalRule extends VideoSelector {
    /** Matching videos that exist at `at` are removed then. */
    at?: number;
    /** Matching videos are removed this long after they were created. */
    afterS?: number;
    /** api-host: "deleted" (404) or "rejected" (status rejected). form-host ignores it. */
    kind?: "removed" | "rejected";
    reason?: string;
}

export interface BannedWord {
    word: string;
    /** form-host: refuse the metadata form, or store the text with the word replaced (with or without a notice). */
    action: "refuse" | "replace" | "replace-notice";
    replacement?: string;
}

export interface Window { at: number; until: number }
type RatioWindow = Window & { ratio?: number };

// ---- file-host ----

export interface HostedFile {
    id: string;
    name: string;
    /** Media source id (default: picked by seed). */
    source?: string;
    /** Which prepared file: the mezzanine (default) or a lower rung, e.g. "rung-360". */
    from?: string;
    album?: string;
    /** When the file appears (seconds from the epoch; default 0). */
    at?: number;
}

export type FileHostFault =
    | RatioWindow & { type: "apiStatus"; status: number | "malformed" | "reset"; api?: "page" | "file" | "link" | "album" | "download" }
    | RatioWindow & { type: "transferStall"; mode: "slow" | "stall" | "cut"; afterBytes: number; bytesPerSecond: number; stallS?: number; file?: string }
    | { type: "etagChange"; at: number; file?: string }
    | Window & { type: "offsiteRedirect"; url: string }
    | { type: "fileRemoved"; at: number; file: string };

export interface FileHostSpec {
    files: HostedFile[];
    albums: Array<{ id: string; title: string }>;
    signatureTtlS?: number;
    /** Redirects between the two hosts after the signed URL, before the bytes. */
    redirectHops?: number;
    albumPageSize?: number;
    /** Host name put in download URLs (default: the bind address). */
    cdnHostname?: string;
    /** The link API needs a Referer from a file page. */
    requireReferer?: boolean;
    faults: FileHostFault[];
}

// ---- form-host ----

export type FormHostFault =
    | { type: "logout"; at: number; account?: string; revokeRemember: boolean }
    | Window & { type: "cacheWindow"; path: string }
    | RatioWindow & { type: "pageStatus"; status: number | "reset"; path?: string }
    | RatioWindow & { type: "chunkFault"; mode: "drop" | "stall" | "login-redirect" | "non-json" | "status"; status?: number; stallS?: number; index?: number }
    | RatioWindow & { type: "listStatus"; status: number }
    | RatioWindow & { type: "tierStatus"; height: number; status: number | "reset" };

export interface FormHostSpec {
    accounts: Array<{ username: string; password: string; displayName?: string }>;
    categories?: Array<{ id: number; name: string }>;
    chunkSize?: number;
    maxBytes?: number;
    titleMax?: number;
    pageSize?: number;
    processingS?: number;
    processingRules: ProcessingRule[];
    removals: RemovalRule[];
    bannedWords: BannedWord[];
    visibilityRules: Array<{ word: string; reason: string }>;
    /** An authenticated page view rotates the session cookie once it is this old. */
    rotateSessionS?: number;
    /** How long a rotated-out session id keeps working. */
    rotationGraceS?: number;
    /** The "My Videos (N)" heading counts videos as of this long ago. */
    listTotalsLagS?: number;
    /** Tab totals still count a removed video this long. */
    removalLagS?: number;
    /** Real-time delay of the final (media-free) assembly request. */
    assemblyDelayMs?: number;
    /** What a signed-out client gets at the upload page. */
    signedOutUpload?: "redirect-login" | "redirect-home" | "login-form";
    faults: FormHostFault[];
}

// ---- api-host ----

export type ApiHostFault =
    | { type: "revokeTokens"; at: number; account?: string }
    | RatioWindow & { type: "apiStatus"; status: number | "reset"; api?: "token" | "videos" | "upload" | "list" | "media" }
    | RatioWindow & { type: "uploadFault"; mode: "drop" | "stall" | "status"; status?: number; stallS?: number };

export interface ApiHostSpec {
    accounts: Array<{ username: string; password: string }>;
    clients: Array<{ clientId: string; clientSecret: string }>;
    accessTokenTtlS?: number;
    rotateRefreshTokens?: boolean;
    maxBytes?: number;
    minDurationS?: number;
    maxDurationS?: number;
    titleMax?: number;
    descriptionMax?: number;
    tagsMax?: number;
    pageSize?: number;
    uploadSessionTtlS?: number;
    processingS?: number;
    processingRules: ProcessingRule[];
    removals: RemovalRule[];
    bannedWords: Array<{ word: string }>;
    quota?: { dailyUnits: number; costs?: Partial<Record<QuotaOperation, number>> };
    faults: ApiHostFault[];
}

export type QuotaOperation = "token" | "list" | "get" | "insert" | "update" | "delete" | "upload";
export const DEFAULT_QUOTA_COSTS: Record<QuotaOperation, number> = { token: 0, list: 1, get: 1, insert: 100, update: 50, delete: 50, upload: 0 };

// ---- checks ----

const id = str(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "an id (letters, digits, _ . -)");
const word = str(/^[^\s'"<>]{1,64}$/, "a single word");
const pageStatus = oneOf(400, 401, 403, 404, 410, 429, 500, 502, 503, 504);
const withReset: Check<number | "reset"> = (v, p, pr) => v === "reset" ? "reset" : pageStatus(v, p, pr);
const window = { at: req(seconds), until: req(seconds) };
const ratio = { ratio: opt(num(0, 1)) };
const regex: Check<string> = (v, p, pr) => {
    const s = str()(v, p, pr);
    if (s === undefined) return undefined;
    try { new RegExp(s, "i"); } catch { pr.push(`${p}: not a regular expression`); return undefined; }
    return s;
};
const selector: Fields = { nth: opt(num(1, 1e6, true)), titleMatches: opt(regex), shorterThanS: opt(num(0)), account: opt(str()) };
const processingRule = object({ ...selector, processingS: opt(num(0, 86400 * 30)), outcome: opt(oneOf("ready", "failed")), recoverAfterS: opt(num(0, 86400 * 30)) });
const removalRule: Check<RemovalRule> = (v, p, pr) => {
    const out = object({ ...selector, at: opt(seconds), afterS: opt(num(0)), kind: opt(oneOf("removed", "rejected")), reason: opt(str()) })(v, p, pr);
    if (out && out.at === undefined && out.afterS === undefined) pr.push(`${p}: a removal needs "at" or "afterS"`);
    return out as RemovalRule | undefined;
};
const bannedWord = object({ word: req(word), action: opt(oneOf("refuse", "replace", "replace-notice"), "refuse"), replacement: opt(str()) });

const fileHostFaults: Record<string, Fields> = {
    apiStatus: { ...window, ...ratio, status: req((v, p, pr) => v === "malformed" ? v : withReset(v, p, pr)), api: opt(oneOf("page", "file", "link", "album", "download")) },
    transferStall: {
        ...window, ...ratio, mode: req(oneOf("slow", "stall", "cut")), afterBytes: opt(num(0, 2 ** 40, true), 65536),
        bytesPerSecond: opt(num(1, 2 ** 40), 65536), stallS: opt(num(0.001, 3600)), file: opt(id),
    },
    etagChange: { at: req(seconds), file: opt(id) },
    offsiteRedirect: { ...window, url: opt(str(/^https?:\/\//, "an http(s) URL"), "http://169.254.169.254/latest/meta-data/") },
    fileRemoved: { at: req(seconds), file: req(id) },
};

const formHostFaults: Record<string, Fields> = {
    logout: { at: req(seconds), account: opt(str()), revokeRemember: opt(bool, true) },
    cacheWindow: { ...window, path: opt(str(/^\//, "a path starting with /"), "/") },
    pageStatus: { ...window, ...ratio, status: req(withReset), path: opt(str(/^\//, "a path starting with /")) },
    chunkFault: {
        ...window, ...ratio, mode: req(oneOf("drop", "stall", "login-redirect", "non-json", "status")),
        status: opt(pageStatus), stallS: opt(num(0.001, 3600)), index: opt(num(0, 1e6, true)),
    },
    listStatus: { ...window, ...ratio, status: req(pageStatus) },
    tierStatus: { ...window, ...ratio, height: req(oneOf(1080, 720, 480, 360)), status: req(withReset) },
};

const apiHostFaults: Record<string, Fields> = {
    revokeTokens: { at: req(seconds), account: opt(str()) },
    apiStatus: { ...window, ...ratio, status: req(withReset), api: opt(oneOf("token", "videos", "upload", "list", "media")) },
    uploadFault: { ...window, ...ratio, mode: req(oneOf("drop", "stall", "status")), status: opt(pageStatus), stallS: opt(num(0.001, 3600)) },
};

const fileHost = object({
    files: req(list(object({ id: req(id), name: req(str(/^[^/\\\0]{1,200}$/, "a file name")), source: opt(id), from: opt(str(/^(mezzanine|rung-\d{2,4})$/, '"mezzanine" or "rung-<height>"')), album: opt(id), at: opt(seconds) }))),
    albums: opt(list(object({ id: req(id), title: req(str()) })), []),
    signatureTtlS: opt(num(1, 86400)),
    redirectHops: opt(num(0, 20, true)),
    albumPageSize: opt(num(1, 500, true)),
    cdnHostname: opt(str(/^[A-Za-z0-9.-]{1,253}$/, "a host name")),
    requireReferer: opt(bool),
    faults: opt(list(tagged(fileHostFaults, Object.keys(fileHostFaults), "file-host fault")), []),
});

const formHost = object({
    accounts: req(list(object({ username: req(str()), password: req(str()), displayName: opt(str()) }))),
    categories: opt(list(object({ id: req(num(1, 1e6, true)), name: req(str()) }))),
    chunkSize: opt(num(1024, 4 * 1024 * 1024, true)),
    maxBytes: opt(num(1, 2 ** 45, true)),
    titleMax: opt(num(1, 10000, true)),
    pageSize: opt(num(1, 500, true)),
    processingS: opt(num(0, 86400 * 30)),
    processingRules: opt(list(processingRule), []),
    removals: opt(list(removalRule), []),
    bannedWords: opt(list(bannedWord), []),
    visibilityRules: opt(list(object({ word: req(word), reason: req(str()) })), []),
    rotateSessionS: opt(num(1, 86400 * 30)),
    rotationGraceS: opt(num(0, 86400)),
    listTotalsLagS: opt(num(0, 86400)),
    removalLagS: opt(num(0, 86400)),
    assemblyDelayMs: opt(num(0, 600000, true)),
    signedOutUpload: opt(oneOf("redirect-login", "redirect-home", "login-form")),
    faults: opt(list(tagged(formHostFaults, Object.keys(formHostFaults), "form-host fault")), []),
});

const apiHost = object({
    accounts: req(list(object({ username: req(str()), password: req(str()) }))),
    clients: opt(list(object({ clientId: req(id), clientSecret: req(str()) })), [{ clientId: "sim-client", clientSecret: "sim-secret" }]),
    accessTokenTtlS: opt(num(1, 86400)),
    rotateRefreshTokens: opt(bool),
    maxBytes: opt(num(1, 2 ** 45, true)),
    minDurationS: opt(num(0)),
    maxDurationS: opt(num(1)),
    titleMax: opt(num(1, 10000, true)),
    descriptionMax: opt(num(1, 100000, true)),
    tagsMax: opt(num(0, 1000, true)),
    pageSize: opt(num(1, 500, true)),
    uploadSessionTtlS: opt(num(1, 86400 * 30)),
    processingS: opt(num(0, 86400 * 30)),
    processingRules: opt(list(processingRule), []),
    removals: opt(list(removalRule), []),
    bannedWords: opt(list(object({ word: req(word) })), []),
    quota: opt(object({
        dailyUnits: req(num(1, 1e12, true)),
        costs: opt(object(Object.fromEntries(Object.keys(DEFAULT_QUOTA_COSTS).map(k => [k, opt(num(0, 1e9, true))])))),
    })),
    faults: opt(list(tagged(apiHostFaults, Object.keys(apiHostFaults), "api-host fault")), []),
});

export const hostSpecChecks: Record<"file-host" | "form-host" | "api-host", Check<any>> = {
    "file-host": fileHost, "form-host": formHost, "api-host": apiHost,
};

/** Cross-field checks once every block parsed. */
export function validateHosts(scenario: Scenario, problems: string[]): void {
    const files = scenario.sites["file-host"];
    if (files) {
        const ids = new Set<string>();
        files.files.forEach((f, i) => {
            if (ids.has(f.id)) problems.push(`scenario.sites.file-host.files[${i}]: duplicate id "${f.id}"`);
            ids.add(f.id);
        });
        const albums = new Set(files.albums.map(a => a.id));
        if (albums.size !== files.albums.length) problems.push("scenario.sites.file-host.albums: duplicate id");
        files.files.forEach((f, i) => {
            if (f.album !== undefined && !albums.has(f.album)) problems.push(`scenario.sites.file-host.files[${i}]: unknown album "${f.album}"`);
        });
        files.faults.forEach((f, i) => {
            if ("file" in f && f.file !== undefined && !ids.has(f.file)) problems.push(`scenario.sites.file-host.faults[${i}]: unknown file "${f.file}"`);
        });
    }
    for (const site of ["form-host", "api-host"] as const) {
        const spec = scenario.sites[site];
        if (!spec) continue;
        const names = new Set(spec.accounts.map(a => a.username));
        if (names.size !== spec.accounts.length) problems.push(`scenario.sites.${site}.accounts: duplicate username`);
        if (spec.accounts.length === 0) problems.push(`scenario.sites.${site}.accounts: at least one account`);
        const rules: Array<[string, VideoSelector[]]> = [["processingRules", spec.processingRules], ["removals", spec.removals]];
        for (const [key, list] of rules) {
            list.forEach((r, i) => {
                if (r.account !== undefined && !names.has(r.account)) problems.push(`scenario.sites.${site}.${key}[${i}]: unknown account "${r.account}"`);
            });
        }
        spec.faults.forEach((f, i) => {
            if ("account" in f && f.account !== undefined && !names.has(f.account)) problems.push(`scenario.sites.${site}.faults[${i}]: unknown account "${f.account}"`);
        });
    }
    const api = scenario.sites["api-host"];
    if (api && api.minDurationS !== undefined && api.maxDurationS !== undefined && api.maxDurationS <= api.minDurationS) {
        problems.push('scenario.sites.api-host: "maxDurationS" must be above "minDurationS"');
    }
}
