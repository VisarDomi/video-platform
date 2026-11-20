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
    // The same logger with another tag in place of the site's label ("[<tag>] ..."), or
    // with none, for the monitored lines whose prefix is not the label. Hosts provide it;
    // a plug-in falls back to its own logger when it is missing (e.g. in a test).
    tagged?(tag?: string): Logger;
}

export interface Clock {
    now(): number;
}

export interface PluginPaths {
    // The plug-in's own durable state directory, owned by the core.
    stateDir: string;
    // The site's download list (one target per line, in the catalog's format).
    downloadList: string;
    // The site's browser profiles, one directory each (persistent sign-ins).
    browserProfiles: string;
    // Per-account sign-in coordination and diagnostics (leases, attention markers).
    loginState: string;
}

export interface PluginContext {
    // The configured instance ID, e.g. "live-a". It names folders, lists and routes.
    siteId: string;
    // The plug-in's own block from the sites file: hosts, accounts, key file paths.
    config: Readonly<Record<string, unknown>>;
    store: PluginStore;
    paths: PluginPaths;
    log: Logger;
    // The logger of the account sign-in code (SiteAuth's login and device provisioning):
    // the auth service's own lines, with no site label, in whichever process signs in.
    // Hosts that sign in on behalf of the auth service (the server's device sign-in)
    // provide it; otherwise it is the host's own logger, log.tagged().
    authLog?: Logger;
    clock: Clock;
    // The core's alias registry, in hosts that keep one (the server). Catalogs that find
    // targets by a former name read and extend it.
    aliases?: AliasBook;
    // The site account's credentials as the auth daemon last saved them (the account the
    // sites file names for the site), read from the core's credential store.
    credentials: CredentialSource;
    // The browser a plug-in launches (sign-ins): the system's own Chromium, which the OS
    // keeps updated. A plug-in never launches a browser a library downloaded (nothing
    // updates those), so it always passes this as the executable.
    browser: { readonly executablePath: string };
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

// How a list knows an entry: by its ID, or by its label while it has none.
export function targetKey(target: Target): string {
    return target.id || target.label;
}

// ---- Catalog: download lists and identity ---------------------------------------

export interface AliasHistory {
    current: string;
    // Former names, oldest first.
    history: string[];
}

// The core's alias registry: every name an ID has been seen under, kept durable by the
// core (one file for the deployment). Catalogs that resolve former names use it.
export interface AliasBook {
    // The ID's current name, if known.
    current(id: string): string | undefined;
    // The ID a current or former name belongs to, if known.
    idForName(name: string): string | undefined;
    // Every known name of the ID, oldest first and the current one last.
    names(id: string): string[] | undefined;
    // Merges names just read from the site; true when anything changed. Durable when it
    // resolves.
    record(id: string, aliases: AliasHistory): Promise<boolean>;
}

// A periodic refresh of the listed targets' names. The core runs it (at start, then
// every intervalMs), keeps the alias registry and rewrites the list atomically: every
// line whose ID has a new current name is written again with formatTargetLine.
export interface AliasRefresh {
    intervalMs: number;
    // true: the names go into the core's alias registry, history included, and the list
    // takes each ID's current name from the registry. Otherwise the list takes the names
    // this refresh returned, and nothing else is kept.
    keepHistory?: boolean;
    // The IDs to refresh, given the list's own (in list order, repeats kept). Default:
    // the list's.
    ids?(listed: string[]): Promise<string[]>;
    // The names of the IDs the site could look up; IDs it could not are left out.
    run(ids: string[]): Promise<Map<string, AliasHistory>>;
}

export interface Catalog {
    // The one parser of a download-list line, shared by every reader of the list
    // (comments and blanks return null). A reader that logs list problems passes warn,
    // which gets a note about a malformed or incomplete line; others parse silently.
    // Pure otherwise.
    parseTargetLine(line: string, warn?: (message: string) => void): Target | null;
    // A new line for a target. The bytes are pinned: other programs read the lists.
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

    // The server side: the core serves /api/<site>/{list,add,remove,member,exists,resolve}
    // from these, and owns the list file and its serialized, atomic rewrites.

    // Resolves user input (an ID, a name, a page URL) through the site to the target it
    // names, or null.
    resolveIdentifier?(input: string): Promise<Target | null>;
    // Runs before a target is added to the list (e.g. follow the account). A throw
    // leaves the list unchanged.
    beforeAdd?(target: Target): Promise<void>;
    // Whether the site itself has this name, listed or not; throws when it cannot say.
    exists?(identifier: string): Promise<boolean>;
    // The listed key (ID, or label for an entry without one) a name belongs to, so names
    // used before a rename still match. `listed` is the list as it is now. Default: the
    // name itself.
    resolveForRemove?(identifier: string, listed: readonly Target[]): Promise<string> | string;
    // The list as clients get it (e.g. IDs, labels and former names). Default: the labels.
    enrichList?(listed: readonly Target[]): string[];
    // The site's pages for a target: its channel and, when the label is a name of its
    // own, the page under that name.
    sourceLinks?(target: Target): { channelUrl: string; aliasUrl: string | null };
    refreshAliases?: AliasRefresh;
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

export interface SiteAccount {
    email: string;
    password: string;
}

// An account's session as the auth daemon holds it: the refresh token, the session
// (access) token it yields, and the rest (short-lived tokens, the site's own state).
export interface TokenBag {
    refreshToken: string;
    sessionToken: string | null;
    extras: Record<string, string | null>;
}

export interface SessionRenewal {
    newSessionToken: string;
    newRefreshToken: string | null;
    // Merged into the bag's extras.
    extras?: Record<string, string>;
}

export interface ShortTokens {
    extras: Record<string, string | null>;
    // A session renewal that happened on the way.
    session?: SessionRenewal;
}

// A session as its consumers read it from the core's credential store.
export interface StoredCredentials {
    // The record the site's auth serialized, as last saved; null when there is none (no
    // file, unreadable or torn).
    record: Record<string, unknown> | null;
    // When the auth daemon saved it, if recorded.
    writtenAtMs: number | null;
    // When it was read.
    readAtMs: number;
}

export interface CredentialSource {
    // Reads the store on every call: the auth daemon replaces the record every few seconds.
    read(): Promise<StoredCredentials>;
}

// What a failure means for the session (rule 5: a decision, not a matched message):
// - outage: the site could not answer; keep the session and retry later;
// - reauthenticate: the site rejected the credentials; sign in again;
// - verification: the site asked for an interactive check that the normal sign-in
//   completes; sign in again;
// - needs-attention: a person has to act; automatic sign-ins stop.
export type AuthDecision = "outage" | "reauthenticate" | "verification" | "needs-attention";

export interface SiteAuth {
    // How often the short-lived tokens and the session are renewed (ms). Pinned per site.
    intervals: { shortTokenRefresh: number; sessionRefresh: number };
    // The record the core's credential store keeps for a bag, and back. Its field names
    // are a contract with every consumer of the site's credentials.
    serializeTokens(bag: TokenBag): Record<string, unknown>;
    deserializeTokens(record: Record<string, unknown>): TokenBag | null;
    // A stored bag that has to sign in once more before use (e.g. an older format).
    needsSessionMigration?(bag: TokenBag): boolean;
    login(account: SiteAccount): Promise<TokenBag>;
    refreshSession(bag: TokenBag): Promise<SessionRenewal>;
    // timeoutMs bounds the request.
    fetchShortTokens(bag: TokenBag, timeoutMs: number): Promise<ShortTokens>;
    classify(error: unknown): AuthDecision;
    // The request headers for the stored credentials; throws when they lack what the
    // kind of request needs. Consumers never build site cookies or headers themselves.
    headersFor(credentials: StoredCredentials, kind: "api" | "stream"): Record<string, string>;
    describeTokens(bag: TokenBag): {
        // When the session token expires (ms since the epoch); drives session renewal.
        sessionExpiresAt?: number;
        // When the short-lived tokens expire (ms since the epoch); absent when the bag has none.
        shortExpiresAt?: number;
        // How the short-lived tokens appear in log lines, e.g. "tte=1800000600".
        summary: string;
    };
    // A separate token family for a phone, provisioned once and then owned by the phone.
    provisionDevice?(account: SiteAccount, requestId: string): Promise<{ cookies: unknown[] }>;
    acknowledgeDevice?(requestId: string): Promise<void>;
}

// ---- Browser extension build inputs -------------------------------------------------

// A Safari web extension a plug-in contributes, declared in the plug-in package's
// `extension.json` (read at build time by live-extensions, so it needs no plug-in build).
// A site plug-in's is a download-list bar: the core builds the bar, the background page
// that talks to the PC and the manifest. A file host plug-in's sends file pages to the PC
// (SendToPcExtensionSpec).
export interface ExtensionSpec {
    // A download-list bar: the open channel's +/- for the PC's download list of this site.
    kind: "download-list";
    // The build folder, and the name the iPhone app's extension entry uses, e.g. "x-live".
    key: string;
    // The extension's display name.
    name: string;
    // The site's public name, as the description says it.
    siteName: string;
    version?: string;
    matches: string[];
    runAt: "document_start" | "document_end";
    // The content-script module, relative to the plug-in package. It exports `adapter` (a
    // DownloadListAdapter) and, with runAt document_start, `onDocumentStart()`, which runs
    // before the page has a body; the bar mounts once it has one.
    entry: string;
}

// A file host's extension: its own content script (the page's download controls) and
// background page, which the build gives __PC_SERVER__ (the PC's file-host service) and
// __API_PATH__ ("/api/<host>"). The manifest's content scripts are its matches with each
// path in turn, e.g. "/f/*" at document_end.
export interface SendToPcExtensionSpec {
    kind: "send-to-pc";
    key: string;
    name: string;
    siteName: string;
    version?: string;
    matches: string[];
    contentScripts: Array<{ path: string; runAt: "document_start" | "document_end" }>;
    // Modules relative to the plug-in package.
    entry: string;
    background: string;
}

// How the bar reads the current page.
export interface DownloadListAdapter {
    // The channel identifier shown on the current page, or null when the current route is
    // not a channel page (the bar hides).
    identify(): string | null;
}
