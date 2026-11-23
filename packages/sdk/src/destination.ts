import { SDK_VERSION } from "./plugin.js";

// ---- Destination ----------------------------------------------------------------------
//
// Where finished recordings are uploaded. Designed from the core's call sites (upload,
// reconcile, the pre-upload lookup, session upkeep), not from a wish list: the core owns
// attempts, reservations, byte accounting, the creation boundary, the seven-day retry,
// daily verification, removal bans and receipt-matched cleanup; a destination plug-in
// only speaks its site's protocol.

export interface UploadRequest {
    readonly recordingId: string;
    // The text the destination is searched by: the "[...]" stamp at the end of the title.
    readonly uploadIdentity: string;
    readonly artifactPath: string;
    readonly sizeBytes: number;
    readonly title: string;
    readonly description: string;
    readonly tags: readonly string[];
    readonly visibility: "private" | "public";
    readonly streamerAlias?: string;
    // Search the destination for the identity first, inside the same session.
    readonly lookupBeforeUpload?: boolean;
    // This destination's videos the core created and believes still exist, newest first
    // (the remote ID captured after submission, the recording, when); empty when an earlier
    // submission of this recording has no captured ID. A destination whose uploads list
    // comes up short of its own totals may account for the shortfall with the ones created
    // recently (a new video can drop out of a list while the site processes it), never with
    // a copy of this recording, and can name any older missing video for diagnosis.
    readonly recentUploads?: readonly { readonly remoteId: string; readonly recordingId: string; readonly submittedAt: string }[];
    // Evidence the core stores with the attempt (it may parse a destination's notices).
    readonly onEvidence?: (evidence: Record<string, unknown>) => Promise<void> | void;
    // Recorded durably by the core before the call returns; "metadata_submitting" is
    // recorded just before the step that creates the remote copy.
    readonly onProgress?: (
        phase: "file_uploading" | "file_uploaded" | "metadata_submitting",
        transmittedBytes: number,
    ) => Promise<void> | void;
}

export interface UploadReceipt {
    readonly transmittedBytes: number;
    readonly submittedVideoId: string | null;
    readonly metadataSubmittedAt: string;
}

// One session per upload: the existence check runs inside the same session, and the
// outcome tells the core what happened.
export type UploadOutcome =
    | { kind: "uploaded"; receipt: UploadReceipt }
    | { kind: "existing"; remoteId: string; remoteUrl: string };

// The destination's uploads list searched for one identity (or one exact remote ID).
// "absent" is only ever said after a complete listing.
export type UploadLookup =
    | { kind: "found"; remoteId: string; remoteUrl: string; processing?: boolean; failed?: boolean }
    | { kind: "absent" | "ambiguous" };

// What the destination stored for an upload, compared with what was sent (destinations
// may silently replace words they filter).
export interface StoredUploadMetadata {
    readonly title: string;
    readonly description: string;
    readonly tags: readonly string[];
    readonly categories: readonly string[];
    readonly categoryIds: readonly string[];
}

// One upload's state, as daily verification sees it. Only "online" (playable in the
// required quality) verifies; "missing" means the destination proved it gone.
export interface UploadProbe {
    readonly outcome: "online" | "missing" | "not_ready";
    readonly remoteUrl: string | null;
    readonly reason?: string;
    readonly processing?: boolean;
    readonly retrySoon?: boolean;
    // "missing" because a complete listing of the account's uploads lacks the video: the
    // destination removed it. (A failed processing stays listed, as failed, and is not
    // this.) The core then never uploads the recording to that destination again.
    readonly removed?: boolean;
    readonly stored?: StoredUploadMetadata | null;
    readonly [evidence: string]: unknown;
}

// A signed-in session, opened once for a batch of lookups and probes.
export interface DestinationSession {
    lookup(identity: string, exactRemoteId?: string): Promise<UploadLookup>;
    probe(remoteId: string): Promise<UploadProbe>;
}

// The state of the destination's stored login, from one light request. A network or
// cache problem throws instead (inconclusive): it never counts as logged out.
export interface DestinationSessionCheck {
    readonly loggedIn: boolean;
    // Names the login in logs and reports without revealing it.
    readonly fingerprint: string | null;
    readonly passwordLoginAt: string | null;
    readonly note: string;
}

export interface Destination {
    // When the remote copy comes into existence: a failure before this point published
    // nothing (a plain failure); after it, the attempt is confirmed before any retry.
    readonly creationBoundary: "metadata_submit" | "transfer_start";
    upload(request: UploadRequest): Promise<UploadOutcome>;
    // The upload carrying this identity, if the destination has one (ambiguous throws).
    findUploadedCopy(identity: string): Promise<{ kind: "found"; remoteId: string; remoteUrl: string } | { kind: "not_found" }>;
    // Runs action in one signed-in session. Whether it may sign in with a password to get
    // one is the destination's rule (one whose login is shared with a phone never does: that would end the phone's login).
    withSession<T>(action: (session: DestinationSession) => Promise<T>): Promise<T>;
    readonly session: {
        check(): Promise<DestinationSessionCheck>;
        // What a session-lost message tells the owner to run. The campaign's attention
        // text carries it, and resuming after a recovery recognises the text by it.
        readonly lostAdvice: string;
        // For a login the account shares with another device (one session per account, the
        // newest login wins, so the core must never sign in again on its own). The core then
        // checks it every ten minutes so it never idles out, records its health, pauses the
        // campaign when it is lost ("<label> shared session is logged out (...); <lostAdvice>")
        // and resumes it once a recovery restored it. restoreCommand is what the owner runs.
        readonly keepAlive?: { readonly label: string; readonly restoreCommand: string };
    };
}

// What the host gives a destination it creates. The host owns the browser profile (it
// refuses everyday and shared profiles); the plug-in only uses it. Where a destination
// keeps its signed-in session is its own business: its state folder, or its config.
export interface DestinationHost {
    // The destination's own block from its sites-file entry ("config"): addresses, choices.
    readonly config: Readonly<Record<string, unknown>>;
    // The destination's private state folder (created by the core, mode 0700), for what it
    // keeps between runs, such as its signed-in session.
    readonly stateDir: string;
    readonly browser: { readonly executablePath: string; readonly profilePath: string; readonly headless?: boolean };
    // Read only when a password login actually happens (never for uploads, lookups or
    // session checks on the shared login), so those keep working without the file.
    readonly credentials: () => { readonly email: string; readonly password: string };
    // Aborted when the host service stops.
    readonly stopSignal: AbortSignal;
}

// A destination's upload limits. The core checks every artifact against them before any
// byte leaves, and uploads with the visibility given.
export interface DestinationPolicy {
    // Shorter recordings wait to be joined with compatible footage (null: no minimum).
    readonly minimumDurationSeconds: number | null;
    readonly maximumDurationSeconds: number | null;
    readonly maximumFileBytes: number;
    readonly uploadVisibility: "public" | "private";
}

export interface SharedSessionCookie {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly secure?: boolean;
    readonly httpOnly?: boolean;
}

export interface SharedSessionSnapshot {
    readonly cookies: readonly SharedSessionCookie[];
    readonly fingerprint: string | null;
    readonly savedAt: string;
}

export interface DestinationPlugin {
    id: string;
    sdkVersion: typeof SDK_VERSION;
    // What the core needs without opening a session: when the remote copy comes into
    // existence (the same as every Destination's creationBoundary), and the upload limits.
    creationBoundary: Destination["creationBoundary"];
    policy: DestinationPolicy;
    createDestination(host: DestinationHost): Destination;
    // Read-only snapshot of a destination's shared login cookies for a companion device.
    // Never logs in, never sends credentials or persistent login tokens.
    readSharedSession?(config: Readonly<Record<string, unknown>>): Promise<SharedSessionSnapshot | null>;
}

// The destinations a deployment uploads to, from its sites file. They are read only by
// the pipeline, so a destination never becomes a capture site:
//
//   { "destinations": [ { "id": "form-host", "plugin": "plugin-form-host",
//                         "commands": "ops-form-host", "config": { ... } } ], "sites": [ ... ] }
//
// "commands" optionally names a package of extra pipeline CLI commands for it; "config" is
// the destination's own block (DestinationHost.config).
export interface DestinationEntry {
    id: string;
    plugin: string;
    commands?: string;
    config?: Record<string, unknown>;
}

const DESTINATION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Whether a value has the form of a destination ID (the ledger stores it with every
// attempt, reservation and removal).
export function isDestinationId(value: unknown): value is string {
    return typeof value === "string" && DESTINATION_ID.test(value);
}

export function parseDestinations(text: string, source = "sites file"): DestinationEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error: any) {
        throw new Error(`${source}: invalid JSON (${error.message})`);
    }
    const list = (parsed as { destinations?: unknown } | null)?.destinations;
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new Error(`${source}: destinations must be a list`);
    const seen = new Set<string>();
    return list.map((raw, index) => {
        const entry = raw as DestinationEntry;
        const where = `${source}: destinations[${index}]`;
        if (typeof entry?.id !== "string" || !DESTINATION_ID.test(entry.id)) throw new Error(`${where}: invalid id ${JSON.stringify(entry?.id)}`);
        if (seen.has(entry.id)) throw new Error(`${where}: duplicate id ${entry.id}`);
        seen.add(entry.id);
        if (typeof entry.plugin !== "string" || !entry.plugin) throw new Error(`${where}: plugin is required`);
        if (entry.commands !== undefined && (typeof entry.commands !== "string" || !entry.commands)) throw new Error(`${where}: commands must be a package name`);
        if (entry.config !== undefined && (typeof entry.config !== "object" || entry.config === null || Array.isArray(entry.config))) {
            throw new Error(`${where}: config must be an object`);
        }
        return { id: entry.id, plugin: entry.plugin, ...(entry.commands ? { commands: entry.commands } : {}), ...(entry.config ? { config: entry.config } : {}) };
    });
}

export async function loadDestinationPlugin(
    entry: DestinationEntry,
    importPlugin: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<DestinationPlugin> {
    const module = await importPlugin(entry.plugin) as { default?: unknown; destination?: unknown };
    const plugin = (module.destination ?? module.default) as DestinationPlugin | undefined;
    if (!plugin || typeof plugin.createDestination !== "function") {
        throw new Error(`Destination ${entry.id}: ${entry.plugin} does not export a destination plug-in`);
    }
    if (plugin.sdkVersion !== SDK_VERSION) {
        throw new Error(`Destination ${entry.id}: ${entry.plugin} targets SDK ${plugin.sdkVersion}, this core runs SDK ${SDK_VERSION}`);
    }
    return plugin;
}

// ---- Errors the core distinguishes ----------------------------------------------------

// The destination refused words in submitted metadata. The form was not accepted, so no
// remote video exists; the phrases are learned for the next description.
export class MetadataRejectedError extends Error {
    constructor(readonly phrases: readonly string[]) {
        super(`Provider rejected metadata phrase(s): ${phrases.map((phrase) => `'${phrase}'`).join(", ")}`);
        this.name = "MetadataRejectedError";
    }
}

// The file transfer stopped before the destination offered its metadata form. On a
// destination whose copy exists only after that form is submitted, nothing was
// published; the next attempt still looks up first.
export class TransferAbortedBeforeSubmissionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TransferAbortedBeforeSubmissionError";
    }
}

// The account's single login moved to another device (or ended). Raised before any
// metadata submission, so it is a plain failure; the campaign pauses until the shared
// session is restored.
export class ProviderSessionLostError extends TransferAbortedBeforeSubmissionError {
    constructor(message: string) {
        super(message);
        this.name = "ProviderSessionLostError";
    }
}

// Only a person can continue (a captcha, a login, a daily limit).
export class HumanActionRequiredError extends Error {
    constructor(readonly action: "captcha" | "session_login" | "daily_limit", message: string) {
        super(message);
        this.name = "HumanActionRequiredError";
    }
}

// The transfer failed after bytes left; acceptanceUnknown says the destination may still
// have the file, so the attempt is confirmed against its uploads list, not retried blind.
export class UploadTransportError extends Error {
    constructor(
        message: string,
        readonly transmittedBytes: number,
        readonly acceptanceUnknown: boolean,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "UploadTransportError";
    }
}

// Session recovery could not run now (another recovery holds the lock, the phone is
// unreachable); it is retried later, never escalated to a password login.
export class RecoveryDeferredError extends Error {}

// ---- Rules shared by the core and destinations ----------------------------------------

// The core reserves an upload's size plus this much for request overhead before any byte
// leaves; a destination must never send more than size + this for one upload.
export const REQUEST_OVERHEAD_RESERVATION_BYTES = 16 * 1024 * 1024;

// Whether a title carries an upload identity: it ends with "[<identity>]". This is how an
// existing upload is recognised on the destination (the duplicate guard).
export function titleCarriesIdentity(title: string, identity: string): boolean {
    return title.trimEnd().endsWith(`[${identity}]`);
}
