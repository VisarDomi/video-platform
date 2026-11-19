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
    readonly stored?: StoredUploadMetadata | null;
    readonly [evidence: string]: unknown;
}

// A signed-in session, opened once for a batch of lookups and probes.
export interface DestinationSession {
    lookup(identity: string, exactRemoteId?: string): Promise<UploadLookup>;
    probe(remoteId: string): Promise<UploadProbe>;
}

// A site's destination capability (a sites-file entry whose plug-in uploads).
export interface Destination {
    // When the remote copy comes into existence: a failure before this point published
    // nothing (a plain failure); after it, the attempt is confirmed before any retry.
    readonly creationBoundary: "metadata_submit" | "transfer_start";
    upload(request: UploadRequest): Promise<UploadOutcome>;
    // Runs action in one signed-in session; it never signs in with a password.
    withSession<T>(action: (session: DestinationSession) => Promise<T>): Promise<T>;
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
