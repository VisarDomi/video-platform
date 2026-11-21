import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
    HumanActionRequiredError, MetadataRejectedError, REQUEST_OVERHEAD_RESERVATION_BYTES, UploadTransportError,
    requestSignal, titleCarriesIdentity,
    type Destination, type DestinationHost, type DestinationSession, type UploadLookup, type UploadOutcome, type UploadProbe, type UploadRequest,
} from "sdk";
import type { ApiHostConfig } from "./config.js";
import { Tokens } from "./tokens.js";

// A video as the API describes it.
export interface ApiVideo {
    id: string;
    clientRef: string | null;
    createdAt: string;
    snippet: { title: string; description: string; tags: string[]; categoryId: string | null };
    status: { uploadStatus: "uploading" | "processing" | "ready" | "failed" | "rejected"; privacyStatus: string; failureReason?: string; rejectionReason?: string };
    upload: { received: number; total: number; complete: boolean } | null;
    renditions: Array<{ height: number; label: string; url: string }>;
    watchUrl: string;
}

interface Answer {
    status: number;
    headers: Headers;
    body: any;
}

// The API's own reason for a refusal ("quotaExceeded", "bannedTerm", ...).
const reasonOf = (answer: Answer): string | null => answer.body?.error?.errors?.[0]?.reason ?? null;

// A video that holds the recording: its file arrived and the host did not refuse it. An
// upload that never completed, a failed processing or a rejection is no copy.
const isCopy = (video: ApiVideo) => video.status.uploadStatus !== "failed" && video.status.uploadStatus !== "rejected"
    && (video.upload?.complete ?? video.status.uploadStatus !== "uploading");

// The upload's key for the host: the same recording and identity give the same key, so a
// create that is asked again (after a crash, a lost answer or an attempt that stopped
// half-way) returns the same video and its upload resumes where the host's bytes end.
export function clientRefOf(request: Pick<UploadRequest, "recordingId" | "uploadIdentity">): string {
    return `vp-${createHash("sha256").update(`${request.recordingId}\n${request.uploadIdentity}`).digest("hex").slice(0, 32)}`;
}

// api-host: an upload API with OAuth tokens and resumable uploads. The video comes into
// existence when its upload session is created, just before the first byte, so the
// creation boundary is the transfer's start: after it, a failure is confirmed against the
// uploads list before any retry, and the retry resumes the same video.
export class ApiHostDestination implements Destination {
    readonly creationBoundary = "transfer_start" as const;
    readonly session: Destination["session"];
    private readonly tokens: Tokens;

    constructor(readonly config: ApiHostConfig, private readonly host: DestinationHost) {
        this.tokens = new Tokens(config, host.stateDir, host.credentials, host.stopSignal);
        this.session = { check: () => this.tokens.check(), lostAdvice: this.tokens.lostAdvice };
    }

    // ---- requests ----

    // An authorized request; a 401 (the access token expired or was revoked) is renewed
    // once. Network errors throw.
    private async call(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Answer> {
        for (let attempt = 1; ; attempt++) {
            const token = await this.tokens.bearer();
            const response = await fetch(path.startsWith("http") ? path : `${this.config.baseUrl}${path}`, {
                method, body: init.body,
                headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.headers ?? {}) },
                signal: requestSignal(this.config.requestTimeoutMs, this.host.stopSignal),
            });
            const text = await response.text();
            if (response.status === 401 && attempt === 1) { this.tokens.forget(); continue; }
            let body: unknown = null;
            try { body = text ? JSON.parse(text) : null; } catch { body = null; }
            return { status: response.status, headers: response.headers, body };
        }
    }

    // ---- the uploads list ----

    // Every video of the account, read to the last page. The host counts them on the first
    // page; a listing that holds another number is incomplete, never a basis for "absent".
    private async listAll(): Promise<ApiVideo[]> {
        const videos = new Map<string, ApiVideo>();
        let total: number | null = null;
        let token: string | undefined;
        for (let page = 1; page <= 10_000; page++) {
            const answer = await this.call("GET", `/v1/videos?pageSize=50${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
            if (answer.status !== 200 || !Array.isArray(answer.body?.items) || typeof answer.body.totalResults !== "number") {
                throw new Error(`api-host: list page ${page} answered ${answer.status}; the listing is incomplete`);
            }
            total ??= answer.body.totalResults as number;
            for (const item of answer.body.items as ApiVideo[]) videos.set(item.id, item);
            token = typeof answer.body.nextPageToken === "string" ? answer.body.nextPageToken : undefined;
            if (!token) break;
        }
        if (videos.size !== total) throw new Error(`api-host: the listing held ${videos.size} of ${total} videos; it is incomplete`);
        return [...videos.values()];
    }

    private async lookup(identity: string, exactRemoteId?: string): Promise<UploadLookup> {
        const videos = await this.listAll();
        const matches = videos.filter((video) => exactRemoteId ? video.id === exactRemoteId : isCopy(video) && titleCarriesIdentity(video.snippet.title, identity));
        if (matches.length > 1) return { kind: "ambiguous" };
        if (!matches.length) return { kind: "absent" };
        const [video] = matches;
        return {
            kind: "found", remoteId: video.id, remoteUrl: video.watchUrl,
            processing: video.status.uploadStatus === "processing", failed: !isCopy(video),
        };
    }

    withSession<T>(action: (session: DestinationSession) => Promise<T>): Promise<T> {
        return this.tokens.bearer().then(() => action({
            lookup: (identity, exactRemoteId) => this.lookup(identity, exactRemoteId),
            probe: (remoteId) => this.probe(remoteId),
        }));
    }

    async findUploadedCopy(identity: string): Promise<{ kind: "found"; remoteId: string; remoteUrl: string } | { kind: "not_found" }> {
        return this.withSession(async (session) => {
            const match = await session.lookup(identity);
            if (match.kind === "ambiguous") throw new Error("api-host: more than one upload carries this identity; refusing another upload");
            return match.kind === "found" ? { kind: "found", remoteId: match.remoteId, remoteUrl: match.remoteUrl } : { kind: "not_found" };
        });
    }

    // ---- verification ----

    private async probe(remoteId: string): Promise<UploadProbe> {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(remoteId)) throw new Error("api-host: not a video ID");
        const answer = await this.call("GET", `/v1/videos/${remoteId}`);
        if (answer.status === 404) {
            // Gone from the API: the complete list confirms it before anything follows.
            const listed = await this.lookup("", remoteId);
            if (listed.kind === "found") return { outcome: "not_ready", remoteUrl: listed.remoteUrl, reason: "the API answered 404 for a listed video", retrySoon: true };
            return { outcome: "missing", remoteUrl: null, removed: true, reason: "the API answered 404 and the complete list does not hold the video" };
        }
        if (answer.status !== 200 || typeof answer.body?.status?.uploadStatus !== "string") {
            return { outcome: "not_ready", remoteUrl: null, reason: `the video answered ${answer.status}`, retrySoon: true };
        }
        const video = answer.body as ApiVideo;
        const stored = {
            title: video.snippet.title, description: video.snippet.description, tags: video.snippet.tags,
            categories: video.snippet.categoryId ? [video.snippet.categoryId] : [], categoryIds: video.snippet.categoryId ? [video.snippet.categoryId] : [],
        };
        switch (video.status.uploadStatus) {
        case "uploading":
            return { outcome: "not_ready", remoteUrl: video.watchUrl, reason: "the upload is incomplete", stored };
        case "processing":
            return { outcome: "not_ready", remoteUrl: video.watchUrl, reason: "api-host is still processing the video", processing: true, stored };
        case "failed":
            return { outcome: "missing", remoteUrl: null, reason: `api-host processing failed (${video.status.failureReason ?? "unknown"}); no video is published`, stored };
        case "rejected":
            return { outcome: "missing", remoteUrl: null, reason: `api-host rejected the video (${video.status.rejectionReason ?? "policy"})`, rejected: true, stored };
        }
        // Online means the best rendition the host made actually plays (answers a range).
        const best = [...(video.renditions ?? [])].sort((a, b) => b.height - a.height)[0];
        if (!best) return { outcome: "not_ready", remoteUrl: video.watchUrl, reason: "ready without renditions", retrySoon: true, stored };
        const media = await fetch(best.url, { headers: { range: "bytes=0-0" }, signal: this.host.stopSignal }).catch(() => null);
        await media?.body?.cancel();
        if (media && (media.status === 206 || media.status === 200)) return { outcome: "online", remoteUrl: video.watchUrl, quality: best.label, stored };
        return { outcome: "not_ready", remoteUrl: video.watchUrl, reason: `the ${best.label} rendition answered ${media?.status ?? "no response"}`, retrySoon: true, stored };
    }

    // ---- upload ----

    // The video and its upload session. A create the host answers with a video whose upload
    // can no longer finish (its session expired, its file failed or was rejected) is asked
    // again under the next key.
    private async create(request: UploadRequest, size: number): Promise<{ video: ApiVideo; session: string; replay: boolean; createdAt: Date }> {
        const base = clientRefOf(request);
        for (let generation = 1; generation <= 5; generation++) {
            const clientRef = generation === 1 ? base : `${base}.${generation}`;
            const createdAt = new Date();
            let answer: Answer;
            try {
                answer = await this.call("POST", "/upload/v1/videos?uploadType=resumable", {
                    headers: { "content-type": "application/json", "x-upload-content-length": String(size), "x-upload-content-type": "video/mp4" },
                    body: JSON.stringify({
                        snippet: { title: request.title, description: request.description, tags: request.tags, ...(this.config.categoryId ? { categoryId: this.config.categoryId } : {}) },
                        status: { privacyStatus: request.visibility }, clientRef,
                    }),
                });
            } catch (error) {
                // The host may have created the video before the answer was lost.
                throw new UploadTransportError(`api-host: the create request failed (${(error as Error).message})`, 0, true, { cause: error });
            }
            if (answer.status === 200 && typeof answer.body?.id === "string" && answer.headers.get("location")) {
                const video = answer.body as ApiVideo;
                const replay = answer.headers.get("x-idempotent-replay") === "true";
                const finishable = video.status.uploadStatus !== "failed" && video.status.uploadStatus !== "rejected";
                if (finishable) return { video, session: answer.headers.get("location")!, replay, createdAt };
                await request.onEvidence?.({ stage: "replaced_unfinishable_upload", remoteId: video.id, clientRef, status: video.status.uploadStatus, reason: video.status.failureReason ?? null });
                continue;
            }
            const reason = reasonOf(answer);
            if (answer.status === 422 && reason === "bannedTerm") {
                const terms = (answer.body.error.errors as Array<{ term?: unknown }>).map((error) => error.term).filter((term): term is string => typeof term === "string");
                throw new MetadataRejectedError([...new Set(terms)]);
            }
            if (answer.status === 403 && reason === "quotaExceeded") throw new HumanActionRequiredError("daily_limit", "api-host: the daily quota is used up");
            // Refused before anything was created (a limit, the title) or a passing problem.
            throw new Error(`api-host: the create answered ${answer.status}${reason ? ` (${reason})` : ""}`);
        }
        throw new Error("api-host: five upload keys of this recording hold unfinishable uploads");
    }

    // How many bytes the host holds for the session: from a 308's Range header (none: 0),
    // or null when the upload is already complete.
    private async received(session: string, size: number): Promise<{ offset: number; done: ApiVideo | null }> {
        const answer = await this.call("PUT", session, { headers: { "content-range": `bytes */${size}` } });
        return this.progressOf(answer, session);
    }

    private progressOf(answer: Answer, session: string): { offset: number; done: ApiVideo | null } {
        if (answer.status === 200 || answer.status === 201) return { offset: Infinity, done: answer.body as ApiVideo };
        if (answer.status === 308) {
            const range = answer.headers.get("range")?.match(/^bytes=0-(\d+)$/);
            return { offset: range ? Number(range[1]) + 1 : 0, done: null };
        }
        const reason = reasonOf(answer);
        if (answer.status === 404) throw new Error(`api-host: the upload session ${reason === "uploadExpired" ? "expired" : "is gone"} (${session.split("/").at(-1)})`);
        throw new Error(`api-host: the upload answered ${answer.status}${reason ? ` (${reason})` : ""}`);
    }

    async upload(request: UploadRequest): Promise<UploadOutcome> {
        await this.tokens.bearer();
        if (request.lookupBeforeUpload) {
            const existing = await this.lookup(request.uploadIdentity);
            if (existing.kind === "ambiguous") throw new Error("api-host: more than one upload carries this identity; refusing another upload");
            if (existing.kind === "found") return { kind: "existing", remoteId: existing.remoteId, remoteUrl: existing.remoteUrl };
        }
        const size = (await stat(request.artifactPath)).size;
        if (size !== request.sizeBytes) throw new Error(`api-host: the artifact is ${size} bytes, not the ${request.sizeBytes} reserved`);

        // The video exists from the create on: the transfer starts here.
        await request.onProgress?.("file_uploading", 0);
        const created = await this.create(request, size);
        const remoteId = created.video.id;
        await request.onEvidence?.({ stage: "remote_created", remoteId, replay: created.replay });

        const budget = size + REQUEST_OVERHEAD_RESERVATION_BYTES;
        let transmitted = 0;
        let failures = 0;
        let state = created.replay ? await this.received(created.session, size).catch((error: Error) => {
            throw new UploadTransportError(error.message, transmitted, true, { cause: error });
        }) : { offset: 0, done: null as ApiVideo | null };
        const file = await open(request.artifactPath, "r");
        try {
            while (!state.done) {
                const end = Math.min(size, state.offset + this.config.chunkBytes) - 1;
                const piece = Buffer.alloc(end - state.offset + 1);
                await file.read(piece, 0, piece.length, state.offset);
                if (transmitted + piece.length > budget) {
                    throw new UploadTransportError("api-host: retries would exceed the reserved bytes", transmitted, true);
                }
                // Counted, and recorded, before it leaves: a reset connection (or a power cut)
                // may have sent it all, and the core bills what was recorded.
                transmitted += piece.length;
                await request.onProgress?.("file_uploading", transmitted);
                const before = state.offset;
                try {
                    const answer = await this.call("PUT", created.session, { headers: { "content-range": `bytes ${state.offset}-${end}/${size}` }, body: piece });
                    state = this.progressOf(answer, created.session);
                } catch (error) {
                    if (this.host.stopSignal.aborted) throw new UploadTransportError("api-host: stopped during the transfer", transmitted, true, { cause: error });
                    if (++failures >= this.config.chunkAttempts) {
                        throw new UploadTransportError(`api-host: the transfer failed ${failures} times in a row (${(error as Error).message})`, transmitted, true, { cause: error });
                    }
                    await delay(this.config.retryDelayMs * failures, undefined, { signal: this.host.stopSignal }).catch(() => {});
                    // Where the host's bytes end, whatever arrived of the failed request.
                    state = await this.received(created.session, size).catch(() => state);
                    continue;
                }
                if (state.offset > before) failures = 0;
            }
        } finally {
            await file.close();
        }
        await request.onProgress?.("file_uploaded", transmitted);
        await request.onEvidence?.({ stage: "file_transfer_complete", remoteId, bytesAcknowledged: size, totalBytes: size });
        return { kind: "uploaded", receipt: { transmittedBytes: transmitted, submittedVideoId: remoteId, metadataSubmittedAt: created.createdAt.toISOString() } };
    }
}
