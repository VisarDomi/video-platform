import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    HumanActionRequiredError, MetadataRejectedError, ProviderSessionLostError, REQUEST_OVERHEAD_RESERVATION_BYTES,
    TransferAbortedBeforeSubmissionError, UploadTransportError, titleCarriesIdentity,
    type Destination, type DestinationHost, type DestinationSession, type DestinationSessionCheck,
    type UploadLookup, type UploadOutcome, type UploadProbe, type UploadRequest,
} from "sdk";
import { FormHostClient, type HostReply } from "./client.js";
import { editPage, genericErrors, hasLoginForm, hasUploadForm, inputValue, listPage, refusedWords, renditions, uploadContext, type ListedVideo } from "./pages.js";

// The destination's block in the sites file:
//   { "id": "form-host", "plugin": "plugin-form-host",
//     "config": { "baseUrl": "http://127.0.0.1:18085", "categoryIds": ["21"] } }
export interface FormHostConfig {
    readonly baseUrl: string;
    // The categories every upload is filed under (the host requires at least one).
    readonly categoryIds: readonly string[];
    // Sign in with the account's password when no session is left (default: yes; this
    // host has no second device whose login a password login would end).
    readonly allowPasswordLogin: boolean;
    // Ask for the remember-me cookie, which restores a lost session without the password.
    readonly rememberMe: boolean;
    // Tries per chunk, and the pause before a retry (times the try number).
    readonly chunkAttempts: number;
    readonly retryDelayMs: number;
}

export function readConfig(raw: Readonly<Record<string, unknown>>): FormHostConfig {
    const baseUrl = raw.baseUrl;
    if (typeof baseUrl !== "string" || !/^https?:\/\/[^/]+/.test(baseUrl)) throw new Error("form-host: config.baseUrl must be an http(s) origin");
    const categoryIds = raw.categoryIds ?? ["21"];
    if (!Array.isArray(categoryIds) || !categoryIds.length || !categoryIds.every((id) => typeof id === "string" && /^\d+$/.test(id))) {
        throw new Error("form-host: config.categoryIds must be a non-empty list of numeric category IDs");
    }
    const flag = (name: string, fallback: boolean): boolean => {
        const value = raw[name] ?? fallback;
        if (typeof value !== "boolean") throw new Error(`form-host: config.${name} must be true or false`);
        return value;
    };
    const count = (name: string, fallback: number, minimum: number): number => {
        const value = raw[name] ?? fallback;
        if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) throw new Error(`form-host: config.${name} must be an integer of at least ${minimum}`);
        return value;
    };
    return {
        baseUrl: baseUrl.replace(/\/+$/, ""), categoryIds,
        allowPasswordLogin: flag("allowPasswordLogin", true), rememberMe: flag("rememberMe", true),
        chunkAttempts: count("chunkAttempts", 3, 1), retryDelayMs: count("retryDelayMs", 1000, 0),
    };
}

const LIST_BLOCK = "/my/videos/?mode=async&function=get_block&block_id=list_videos_my_uploaded_videos&sort_by=";
// Multipart framing per chunk request, counted against the request-overhead reservation.
const CHUNK_FRAMING_BYTES = 1024;

const isRedirect = (reply: HostReply) => reply.status >= 300 && reply.status < 400;
// A shared cache answered for someone else: nothing about this session follows from it.
const cached = (reply: HostReply) => reply.headers.get("x-cache-status") === "HIT" || Number(reply.headers.get("age") ?? 0) > 0;

export class FormHostDestination implements Destination {
    // The video exists once its metadata form is submitted.
    readonly creationBoundary = "metadata_submit" as const;
    readonly session: Destination["session"];

    constructor(readonly config: FormHostConfig, private readonly host: DestinationHost) {
        this.session = {
            check: () => this.checkSession(),
            lostAdvice: config.allowPasswordLogin
                ? "the next upload signs the form host in again with the account's password"
                : "sign the form host in again (password logins are off for it)",
        };
    }

    // A redirect to the home or login page: the host signed this session out.
    private signedOutRedirect(reply: HostReply): boolean {
        return isRedirect(reply) && /^\/(?:login\/)?$/.test(new URL(reply.location ?? "", this.config.baseUrl).pathname);
    }

    // Any other redirect is unexpected: a passing problem, never a reason to sign in.
    private requireSignedIn(reply: HostReply): void {
        if (this.signedOutRedirect(reply)) throw new ProviderSessionLostError(`form-host is signed out; ${this.session.lostAdvice}`);
        if (isRedirect(reply)) throw new Error(`form-host: an unexpected redirect to ${reply.location ?? "nowhere"}`);
    }

    private client(): FormHostClient {
        return new FormHostClient(this.config.baseUrl, path.join(this.host.stateDir, "session.json"), this.host.stopSignal);
    }

    // ---- session ----

    private async checkSession(): Promise<DestinationSessionCheck> {
        const client = this.client();
        const reply = await client.request("/upload-video/");
        if (cached(reply)) throw new Error("form-host: the upload page came from a shared cache; the session state is unknown");
        const loggedIn = reply.status === 200 && hasUploadForm(reply.text);
        const loggedOut = this.signedOutRedirect(reply) || (reply.status === 200 && hasLoginForm(reply.text));
        if (!loggedIn && !loggedOut) throw new Error(`form-host: the upload page answered ${reply.status}; the session state is unknown`);
        const token = client.cookie("remember") ?? client.cookie("sid");
        return {
            loggedIn,
            fingerprint: token ? createHash("sha256").update(token).digest("hex").slice(0, 12) : null,
            passwordLoginAt: client.passwordLoginAt,
            note: loggedIn ? "the upload page shows the file form" : "the upload page asks for a login",
        };
    }

    private async signIn(client: FormHostClient): Promise<void> {
        if (!client.has("consent")) await client.request("/consent/", { method: "POST", body: new URLSearchParams({ back: "/" }) });
        for (let attempt = 1; ; attempt++) {
            const page = await client.request("/login/");
            if (isRedirect(page)) return; // The remember-me cookie signed in already.
            // A cached or failing login page is a passing problem, not a refused login.
            if (cached(page)) throw new Error("form-host: the login page came from a shared cache");
            const csrf = page.status === 200 ? inputValue(page.text, "csrf_token") : null;
            if (!csrf) throw new Error(`form-host: the login page (${page.status}) has no form`);
            const { email, password } = this.host.credentials();
            const form = new URLSearchParams({ action: "login", csrf_token: csrf, username: email, pass: password });
            if (this.config.rememberMe) form.set("remember_me", "1");
            const reply = await client.request("/login/", { method: "POST", body: form });
            if (isRedirect(reply)) { await client.notePasswordLogin(new Date()); return; }
            if (reply.status === 403 && attempt < 2) continue; // A stale security token: once more.
            const errors = genericErrors(reply.text);
            // Only the login form answered again with its error is a refusal a person must
            // look at (the account's password); anything else is retried later.
            if (reply.status === 200 && hasLoginForm(reply.text) && errors.length) {
                throw new HumanActionRequiredError("session_login", `form-host refused the login: ${errors.join(" ")}`);
            }
            throw new Error(`form-host: the login answered ${reply.status}`);
        }
    }

    // The signed-in upload page (the session check, and the page the upload starts from).
    private async uploadPage(client: FormHostClient): Promise<string> {
        for (let attempt = 1; ; attempt++) {
            const reply = await client.request("/upload-video/");
            if (cached(reply)) throw new Error("form-host: the upload page came from a shared cache");
            if (reply.status === 200 && hasUploadForm(reply.text)) return reply.text;
            const signedOut = this.signedOutRedirect(reply) || (reply.status === 200 && hasLoginForm(reply.text));
            if (!signedOut) throw new Error(`form-host: the upload page answered ${reply.status}`);
            if (attempt > 1 || !this.config.allowPasswordLogin) {
                throw new ProviderSessionLostError(`form-host is signed out; ${this.session.lostAdvice}`);
            }
            await this.signIn(client);
        }
    }

    withSession<T>(action: (session: DestinationSession) => Promise<T>): Promise<T> {
        const client = this.client();
        return this.uploadPage(client).then(() => action({
            lookup: (identity, exactRemoteId) => this.lookup(client, identity, exactRemoteId),
            probe: (remoteId) => this.probe(client, remoteId),
        }));
    }

    // ---- the uploads list ----

    // Every video of the account. One scan can miss a video when the list shifts under it
    // (a removal moves later rows up a page), so two scans in a row must agree.
    private async listAll(client: FormHostClient): Promise<ListedVideo[]> {
        let previous = await this.scan(client);
        for (let scan = 2; scan <= 3; scan++) {
            const current = await this.scan(client);
            const ids = (videos: ListedVideo[]) => videos.map((video) => video.id).sort().join(",");
            if (ids(current) === ids(previous)) return current;
            previous = current;
        }
        throw new Error("form-host: the uploads list kept changing while it was read; the listing is inconclusive");
    }

    // Both tabs, read to the end: past the last page the host answers 404, asked twice (a
    // single 404 can be transient). A page the block said exists answering anything but its
    // rows, or a page from a shared cache, means the listing is incomplete.
    private async scan(client: FormHostClient): Promise<ListedVideo[]> {
        const videos = new Map<string, ListedVideo>();
        for (const isPrivate of [0, 1]) {
            let page = 1, known = 1, misses = 0;
            for (;;) {
                const reply = await client.request(`${LIST_BLOCK}&is_private=${isPrivate}&from_my_videos=${page}`);
                this.requireSignedIn(reply);
                if (cached(reply)) throw new Error(`form-host: list page ${page} came from a shared cache; the listing is incomplete`);
                if (reply.status === 404) {
                    if (page <= known) throw new Error(`form-host: list page ${page} of ${known} answered 404; the listing is incomplete`);
                    if (++misses >= 2) break;
                    await delay(this.config.retryDelayMs, undefined, { signal: this.host.stopSignal });
                    continue;
                }
                const parsed = reply.status === 200 ? listPage(reply.text) : null;
                if (!parsed) throw new Error(`form-host: list page ${page} answered ${reply.status}; the listing is incomplete`);
                known = Math.max(known, parsed.pages);
                misses = 0;
                for (const video of parsed.videos) videos.set(video.id, video);
                page++;
            }
        }
        return [...videos.values()];
    }

    private remoteUrl(video: ListedVideo): string {
        // A published row links its page; until then the edit page names it (the host
        // answers the slugless /video/<id>/ with 404 whatever the state).
        return new URL(video.path ?? `/edit-video/${video.id}/`, this.config.baseUrl).href;
    }

    private async lookup(client: FormHostClient, identity: string, exactRemoteId?: string): Promise<UploadLookup> {
        const videos = await this.listAll(client);
        // A failed upload holds no video: it is no copy of the recording.
        const matches = videos.filter((video) => exactRemoteId ? video.id === exactRemoteId : !video.failed && titleCarriesIdentity(video.title, identity));
        if (matches.length > 1) return { kind: "ambiguous" };
        if (!matches.length) return { kind: "absent" };
        const [video] = matches;
        return { kind: "found", remoteId: video.id, remoteUrl: this.remoteUrl(video), processing: video.processing, failed: video.failed };
    }

    async findUploadedCopy(identity: string): Promise<{ kind: "found"; remoteId: string; remoteUrl: string } | { kind: "not_found" }> {
        return this.withSession(async (session) => {
            const match = await session.lookup(identity);
            if (match.kind === "ambiguous") throw new Error("form-host: more than one upload carries this identity; refusing another upload");
            return match.kind === "found" ? { kind: "found", remoteId: match.remoteId, remoteUrl: match.remoteUrl } : { kind: "not_found" };
        });
    }

    // ---- verification ----

    private async probe(client: FormHostClient, remoteId: string): Promise<UploadProbe> {
        if (!/^\d+$/.test(remoteId)) throw new Error("form-host: video IDs are numeric");
        const edit = await client.request(`/edit-video/${remoteId}/`);
        this.requireSignedIn(edit);
        if (cached(edit)) return { outcome: "not_ready", remoteUrl: null, reason: "the edit page came from a shared cache", retrySoon: true };
        if (edit.status === 404) {
            // The edit page is 404 while processing, after a failure and after removal:
            // only the complete list tells them apart.
            const listed = await this.lookup(client, "", remoteId);
            if (listed.kind === "found" && listed.failed) return { outcome: "missing", remoteUrl: null, reason: "form-host processing failed; no video is published" };
            if (listed.kind === "found" && listed.processing) return { outcome: "not_ready", remoteUrl: null, reason: "form-host is still processing the video", processing: true };
            if (listed.kind === "found") return { outcome: "not_ready", remoteUrl: listed.remoteUrl, reason: "listed as published; the edit page is not available yet", retrySoon: true };
            return { outcome: "missing", remoteUrl: null, reason: "the edit page is 404 and the complete list does not hold the video" };
        }
        const stored = edit.status === 200 ? editPage(edit.text) : null;
        if (!stored) return { outcome: "not_ready", remoteUrl: null, reason: `the edit page answered ${edit.status}`, retrySoon: true };
        const metadata = { title: stored.title, description: stored.description, tags: stored.tags, categories: stored.categoryIds, categoryIds: stored.categoryIds };
        const page = await client.request(new URL(stored.url).pathname);
        const tiers = page.status === 200 ? renditions(page.text) : [];
        if (!tiers.length) return { outcome: "not_ready", remoteUrl: stored.url, reason: `the video page answered ${page.status} without renditions`, retrySoon: true, stored: metadata };
        // Online means the best rendition the host made actually plays (answers a range).
        const best = tiers[0];
        const media = await fetch(best.url, { headers: { range: "bytes=0-0" }, signal: this.host.stopSignal }).catch(() => null);
        await media?.body?.cancel();
        if (media && (media.status === 206 || media.status === 200)) {
            return { outcome: "online", remoteUrl: stored.url, quality: best.label, notices: stored.notices, stored: metadata };
        }
        return { outcome: "not_ready", remoteUrl: stored.url, reason: `the ${best.label} rendition answered ${media?.status ?? "no response"}`, retrySoon: true, stored: metadata };
    }

    // ---- upload ----

    async upload(request: UploadRequest): Promise<UploadOutcome> {
        const client = this.client();
        const page = await this.uploadPage(client);
        if (request.lookupBeforeUpload) {
            const existing = await this.lookup(client, request.uploadIdentity);
            if (existing.kind === "ambiguous") throw new Error("form-host: more than one upload carries this identity; refusing another upload");
            if (existing.kind === "found") return { kind: "existing", remoteId: existing.remoteId, remoteUrl: existing.remoteUrl };
        }
        const context = uploadContext(page);
        const uploadToken = inputValue(page, "upload_token");
        const csrf = inputValue(page, "csrf_token");
        if (!context || !uploadToken || !csrf) throw new Error("form-host: the upload page lacks its upload settings");
        const size = (await stat(request.artifactPath)).size;
        if (size !== request.sizeBytes) throw new Error(`form-host: the artifact is ${size} bytes, not the ${request.sizeBytes} reserved`);

        // The file, in the page's chunks; a failed chunk is sent again under its index.
        // Nothing exists on the host until the metadata form is submitted.
        const file = await openAsBlob(request.artifactPath);
        const name = path.basename(request.artifactPath);
        const chunk = context.uploadChunkSize;
        const total = Math.max(1, Math.ceil(size / chunk));
        const budget = size + REQUEST_OVERHEAD_RESERVATION_BYTES;
        let transmitted = 0;
        for (let index = 0; index < total; index++) {
            const piece = file.slice(index * chunk, Math.min(size, (index + 1) * chunk));
            for (let attempt = 1; ; attempt++) {
                if (transmitted + piece.size + CHUNK_FRAMING_BYTES > budget) {
                    throw new UploadTransportError("form-host: retries would exceed the reserved bytes", transmitted, false);
                }
                const form = new FormData();
                form.set("upload_token", uploadToken);
                form.set("index", String(index));
                form.set("total", String(total));
                form.set("filename", name);
                form.set("content", piece, name);
                // Counted, and recorded, before it leaves: a reset connection (or a power cut)
                // may have sent it all, and the core bills what was recorded.
                transmitted += piece.size + CHUNK_FRAMING_BYTES;
                await request.onProgress?.("file_uploading", transmitted);
                const reply = await client.request(context.uploadUrl, { method: "POST", body: form }).catch((error: unknown) => error as Error);
                if (!(reply instanceof Error)) {
                    this.requireSignedIn(reply);
                    const answer = reply.status === 200 ? parseJson(reply.text) : null;
                    if (answer?.status === "success") break;
                }
                if (this.host.stopSignal.aborted) throw new TransferAbortedBeforeSubmissionError("form-host: stopped during the transfer");
                if (attempt >= this.config.chunkAttempts) {
                    const why = reply instanceof Error ? reply.message : `HTTP ${reply.status}`;
                    throw new TransferAbortedBeforeSubmissionError(`form-host: chunk ${index + 1} of ${total} failed ${attempt} times (${why})`);
                }
                await delay(this.config.retryDelayMs * attempt, undefined, { signal: this.host.stopSignal });
            }
        }
        const finish = new FormData();
        finish.set("upload_token", uploadToken);
        finish.set("total", String(total));
        finish.set("filename", name);
        finish.set("filesize", String(size));
        const finished = await client.request(context.finishUrl, { method: "POST", body: finish });
        this.requireSignedIn(finished);
        const assembled = parseJson(finished.text);
        const fileToken = assembled?.status === "success" && typeof assembled.file_token === "string" ? assembled.file_token : null;
        if (!fileToken) throw new TransferAbortedBeforeSubmissionError(`form-host: the upload was not assembled (${finished.status} ${finished.text.slice(0, 200)})`);
        await request.onProgress?.("file_uploaded", transmitted);
        await request.onEvidence?.({ stage: "file_transfer_complete", bytesAcknowledged: size, totalBytes: size });

        // The metadata form creates the video: recorded just before it is sent.
        const metadata = new URLSearchParams({
            action: "add_video", csrf_token: csrf, file_token: fileToken,
            title: request.title, description: request.description, tags: request.tags.join(", "),
            is_private: request.visibility === "private" ? "1" : "0",
        });
        for (const id of this.config.categoryIds) metadata.append("category_ids[]", id);
        await request.onProgress?.("metadata_submitting", transmitted);
        const submittedAt = new Date();
        const reply = await client.request("/upload-video/", { method: "POST", body: metadata });
        if (!(reply.status === 200 && /class="upload-success"/.test(reply.text))) {
            const errors = genericErrors(reply.text);
            const words = refusedWords(errors.join("\n"));
            // A refused word answers the form again: nothing was created.
            if (words.length) throw new MetadataRejectedError(words);
            throw new Error(`form-host: the metadata form answered ${reply.status}${errors.length ? `: ${errors.join(" ")}` : ""}`);
        }
        // The new video is listed (processing) at once; capture its ID now. When that fails,
        // the core confirms the attempt against the list later; the reason is kept.
        const listed = await this.lookup(client, request.uploadIdentity).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
        const remoteId = !(listed instanceof Error) && listed.kind === "found" ? listed.remoteId : null;
        if (remoteId) await request.onEvidence?.({ stage: "remote_identity_captured", remoteId });
        else await request.onEvidence?.({ stage: "remote_identity_not_captured", reason: listed instanceof Error ? listed.message : listed.kind });
        return { kind: "uploaded", receipt: { transmittedBytes: transmitted, submittedVideoId: remoteId, metadataSubmittedAt: submittedAt.toISOString() } };
    }
}

function parseJson(text: string): Record<string, unknown> | null {
    try { const value = JSON.parse(text); return value && typeof value === "object" ? value as Record<string, unknown> : null; } catch { return null; }
}
