import type { IStreamProvider, ProviderLiveStream, ProviderSnapshot } from "./capture.js";
import type { PluginStore } from "./store.js";

// A plug-in is one kind of site. The core loads the plug-ins named in the sites file,
// creates one instance per configured site, and iterates them; it never switches on a
// site ID. Plug-ins depend only on this package; nothing depends on a plug-in.

export const SDK_VERSION = 1;

export interface Logger {
    debug(message: string, meta?: Record<string, unknown>): void;
    // Detail between info and debug.
    verbose(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
}

export interface Clock {
    now(): number;
}

export interface PluginPaths {
    // The plug-in's own durable state directory, owned by the core.
    stateDir: string;
    // The site's download list (one target per line, in the catalog's format).
    downloadList: string;
}

export interface PluginContext {
    // The configured instance ID, e.g. "live-a". It names folders, lists and routes.
    siteId: string;
    // The plug-in's own block from the sites file: hosts, accounts, key file paths.
    config: Readonly<Record<string, unknown>>;
    store: PluginStore;
    paths: PluginPaths;
    log: Logger;
    clock: Clock;
}

export interface SitePlugin {
    // The plug-in type, e.g. "ts-live".
    id: string;
    // The site's display name and the prefix of its log lines ("[Live A] ..."). It lives in
    // the plug-in, not in the sites file, so a deployment cannot change a monitored prefix.
    label: string;
    sdkVersion: typeof SDK_VERSION;
    create(context: PluginContext): SiteInstance | Promise<SiteInstance>;
}

export interface SiteInstance {
    catalog?: Catalog;
    capture?: LiveCapture;
    auth?: SiteAuth;
    fileHost?: FileHost;
    extension?: ExtensionSpec;
    destination?: Destination;
    // Called once by the host after it has read the site's download list, before the first
    // poll: slow or logged start-up work (e.g. loading key files) goes here, not in create.
    init?(): Promise<void> | void;
    // Stops timers and watchers the instance started.
    close?(): Promise<void> | void;
}

// ---- Results shared by every capability -------------------------------------------

// The site answered that the thing does not exist.
export interface Absent { kind: "absent"; evidence?: string }
// The site could not answer: network, cache, outage or an unexpected page. Never a
// negative; the core retries later.
export interface Inconclusive { kind: "inconclusive"; reason: string }

// One download-list entry. `id` is the site's stable identity (it keys sessions and
// lookups); `label` is the human name, also the alias that names recording folders.
// A site may keep an entry it has not resolved to an ID yet: its `id` is "" and it is
// never looked up, but it still counts as listed.
export interface Target {
    id: string;
    label: string;
}

// ---- Catalog: download lists and identity ---------------------------------------

export interface AliasHistory {
    current: string;
    history: string[];
}

export interface Catalog {
    // The one parser of a download-list line (comments and blanks return null). It may
    // warn through ctx.log about a malformed line; it has no other side effects.
    parseTargetLine(line: string): Target | null;
    formatTargetLine(target: Target): string;
    // The comment a new, empty download list starts with.
    listHeader?: string;
    // How a reload of the list is reported in the log. "id" (the default): an entry is
    // added or removed when its ID appears or disappears, so a new label alone logs
    // nothing. "entry": the whole entry counts, so a new label logs as one removed and
    // one added entry.
    listChangesBy?: "id" | "entry";
    // How an entry is named in those log lines. Default: "<label> (<id>)".
    describeTarget?(target: Target): string;

    // The server side of the catalog. Optional until the server reads its lists through
    // the catalog (it keeps its own parsers for now).

    // Resolves user input (an ID, a name, a page URL) through the site.
    resolveIdentifier?(input: string): Promise<Target | null>;
    // Runs before a target is added to the list (e.g. follow the account).
    beforeAdd?(target: Target): Promise<void>;
    // Whether the site itself has this name, listed or not; throws when it cannot say.
    exists?(identifier: string): Promise<boolean>;
    // The listed ID a name belongs to, so names used before a rename still match.
    resolveForRemove?(identifier: string): Promise<string> | string;
    // Extra list rows for clients (e.g. historical aliases next to each ID).
    enrichList?(targets: Target[]): string[];
    sourceLinks?(target: Target): { channelUrl?: string; aliasUrl?: string };
    refreshAliases?: {
        intervalMs: number;
        run(ids: string[]): Promise<Map<string, AliasHistory>>;
    };
}

// ---- Live capture -------------------------------------------------------------------

// What the core knows about the captures it is running, for a lookup that needs it.
export interface RunningCaptures {
    // The recording identity of the capture running for a target, or null.
    recordingId(targetId: string): string | null;
}

export interface LiveCapture {
    // How long the core waits between two lookups: from the end of one poll to the start
    // of the next, or from the start of one poll to the start of the next when
    // pollFromStart is set (a slow lookup then keeps the cadence).
    pollIntervalMs: number;
    pollFromStart?: boolean;
    // The message the core logs (with {error}) when a poll throws. Default: "Poll error".
    pollErrorMessage?: string;
    // A live target whose running capture has another recording identity than the
    // lookup reports gets that capture ended ("a new stream replaced it") and a new one
    // started, also when the old one has no folder on disk yet. Off: a target with a
    // running capture is skipped; its folder is still judged by the disk reconcile.
    replaceSessionOnNewRecording?: boolean;
    // Who is live among the listed targets. null = the site could not answer (or there
    // was nothing to ask); it is never taken as "all offline", so no live capture ends on
    // a lookup failure. The core reconciles the snapshot with the recordings on disk.
    lookup(targets: Target[], running: RunningCaptures): Promise<ProviderSnapshot | null>;
    // Called just before a capture starts, when the lookup could not give the master
    // playlist (e.g. a per-stream handshake). Returns the stream to capture, with its
    // masterPlaylistUrl and possibly a fresher name or recording identity read in the
    // same request, or null when it cannot start now (the plug-in logs why). Without it,
    // the snapshot's stream starts as it is. The core calls it only within the poll whose
    // lookup reported the stream, right after that lookup, so per-poll state the lookup
    // kept is still current. A target in the snapshot's unidentifiedTargetIds comes with
    // an empty recordingId; the returned stream must carry one.
    resolveMaster?(live: ProviderLiveStream): Promise<ProviderLiveStream | null>;
    // The listed target a recording folder belongs to, from the alias in its name
    // (labels may be stale names). Default: the target whose label is the alias.
    targetIdForFolderAlias?(alias: string, targets: readonly Target[]): string | null;
    // The protocol side: playlists, segments, variants, copy failover. Its providerName
    // must be the site ID (it names the recording folders).
    provider: IStreamProvider;
    mediaFormat: "ts" | "fmp4";
}

// ---- Site accounts ------------------------------------------------------------------

export type TokenBag = Record<string, unknown>;

export interface SiteAuth {
    intervals: { refreshMs: number; shortTokenMs: number };
    login(account: string): Promise<TokenBag>;
    refreshSession(bag: TokenBag): Promise<TokenBag>;
    fetchShortTokens(bag: TokenBag): Promise<TokenBag>;
    // Typed decision instead of matching error messages.
    classify(error: unknown): "outage" | "reauthenticate" | "needs-attention";
    // Consumers never build site cookies or headers themselves.
    headersFor(bag: TokenBag, kind: "api" | "stream"): Record<string, string>;
    describeTokens(bag: TokenBag): { expiresAt?: number };
    // A separate token family for a phone, provisioned once and then owned by the phone.
    provisionDevice?(account: string, requestId: string): Promise<Record<string, unknown>>;
    acknowledgeDevice?(requestId: string): Promise<void>;
}

// ---- File host ------------------------------------------------------------------------

export interface FileHost {
    canonicalPage(url: string): string | null;
    // The core still checks every redirect hop against this (SSRF guard).
    isAllowedHost(url: URL): boolean;
    resolve(page: string): Promise<{ url: string; filename: string; headers?: Record<string, string> }>;
    // Stable job key for a page; the browser extension computes the same.
    jobKey(page: string): string;
}

// ---- Browser extension build inputs -------------------------------------------------

export interface ExtensionSpec {
    kind: "download-list" | "send-to-pc" | "login-handoff";
    name: string;
    matches: string[];
    runAt: "document_start" | "document_end" | "document_idle";
    // Path of the content-script module that classifies pages (identify()).
    entry: string;
}

// ---- Destination ----------------------------------------------------------------------

export interface DestinationLimits {
    minDurationS: number;
    maxDurationS?: number;
    maxBytes: number;
    titleMax: number;
    descriptionMax: number;
    tagsMax: number;
    visibility: string;
}

export type SessionCheck =
    | { kind: "signed_in"; fingerprint: string }
    | { kind: "signed_out"; evidence: string }
    | Inconclusive;

export interface ByteMeter {
    // Resolves once the claim is durably recorded; bytes may leave only after that.
    claim(bytes: number): Promise<void>;
    // Bytes the destination acknowledged, for progress only.
    acknowledged(bytes: number): void;
}

export interface UploadMetadata {
    title: string;
    description: string;
    tags: string[];
    category?: string;
    visibility: string;
}

export interface UploadJob {
    attemptId: string;
    filePath: string;
    sizeBytes: number;
    durationS: number;
    // The identity the destination will be searched by (the title's bracket stamp).
    identity: string;
    metadata: UploadMetadata;
}

export type UploadOutcome =
    | { kind: "submitted"; remoteId?: string; url?: string }
    | { kind: "rejected"; phrases: string[] }
    | { kind: "failed"; beforeCreation: boolean; reason: string };

export type LookupResult =
    | { kind: "found"; remoteId: string; url?: string; processing: boolean; failed: boolean }
    | { kind: "absent"; completeness: string }
    | { kind: "ambiguous" }
    | Inconclusive;

export type ProbeResult =
    | { kind: "online"; tier: string; url: string }
    | { kind: "processing" }
    | { kind: "not_ready"; reason: string; retrySoon: boolean }
    | { kind: "failed_processing" }
    | Absent
    | Inconclusive;

export interface Destination {
    limits(): DestinationLimits;
    // When the remote copy comes into existence: failures before this point are plain
    // failures; after it, the core waits for verification before retrying.
    creationBoundary: "metadata_submit" | "transfer_start" | "api_create";
    remoteIdPattern: RegExp;
    requiresBrowser?: boolean;
    session: {
        cadenceMs: number;
        check(): Promise<SessionCheck>;
        maintain(): Promise<void>;
        recover(options: { allowPasswordLogin: boolean }): Promise<"recovered" | "deferred" | "failed">;
    };
    upload(job: UploadJob, meter: ByteMeter): Promise<UploadOutcome>;
    lookup(identity: string, exactId?: string): Promise<LookupResult>;
    probe(remoteId: string): Promise<ProbeResult>;
    // The core never builds destination URLs itself.
    canonicalUrl(remoteId: string): string;
    parseNotices?(text: string): { rejectedPhrases: string[]; visibility?: string };
    retirementUrlPatterns: string[];
}
