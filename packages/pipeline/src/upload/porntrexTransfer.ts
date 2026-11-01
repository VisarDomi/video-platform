/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "playwright";
import { REQUEST_OVERHEAD_RESERVATION_BYTES } from "../domain/uploadBudget.js";

// KVS supports arbitrary slices and retries an aborted XHR at the same index.
// Keep a bad connection from wasting a 200 MiB request or the accepted prefix.
export const PORNTREX_CHUNK_BYTES = 4 * 1024 * 1024;
export const PORNTREX_CHUNK_IDLE_MS = 60_000;
const ENVELOPE_ALLOWANCE = 2048;
export interface PorntrexTransferState {
    bytesObserved: number;
    acceptedPayloadBytes: number;
    acceptedChunks: number;
    abortedChunks: number;
    claimedBytes: number;
    failure: string | null;
}

export async function preparePorntrexTransfer(page: Page, sizeBytes: number,
    persist: (bytes: number) => Promise<void>,
    options: { chunkBytes?: number; idleMs?: number } = {}): Promise<void> {
    const limit = sizeBytes + REQUEST_OVERHEAD_RESERVATION_BYTES;
    let persisted = sizeBytes;
    await page.exposeFunction("__pipelineClaimChunk", async (bytes: number) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) throw new Error("Invalid upload chunk byte claim");
        // Full-file intent is already durable. Persist any additional chunk
        // retry/envelope allowance before the browser can transmit those bytes.
        if (bytes > persisted) { await persist(bytes); persisted = bytes; }
    });
    await page.evaluate(({ sizeBytes, limit, chunkBytes, idleMs, envelope }) => {
        type TrackedWindow = Window & {
            pageContext?: { upload_chunk_size?: string | number };
            __pipelineClaimChunk: (bytes: number) => Promise<void>;
            __pipelineTransfer?: PorntrexTransferState;
        };
        const w = window as unknown as TrackedWindow;
        if (w.__pipelineTransfer) throw new Error("Upload transfer monitor already installed");
        if (!w.pageContext) throw new Error("Porntrex chunk configuration is missing");
        const configured = Number(w.pageContext.upload_chunk_size);
        const effectiveChunkBytes = Math.min(configured > 0 ? configured : chunkBytes, chunkBytes);
        w.pageContext.upload_chunk_size = effectiveChunkBytes;
        const state: PorntrexTransferState = w.__pipelineTransfer = {
            bytesObserved: 0, acceptedPayloadBytes: 0, acceptedChunks: 0, abortedChunks: 0, claimedBytes: 0, failure: null,
        };
        const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
        const targets = new WeakSet<XMLHttpRequest>();
        const attempts = new Map<string, number>();
        const accepted = new Set<string>();
        let acceptedBytes = 0;
        XMLHttpRequest.prototype.open = function(method, url, ...rest: [boolean?, string?, string?]) {
            const parsed = new URL(String(url), location.href);
            if (method.toUpperCase() === "POST" && parsed.origin === location.origin && parsed.pathname === "/upload-video/") targets.add(this);
            else targets.delete(this);
            // Preserve the native overload (including synchronous requests).
            return Reflect.apply(open, this, [method, url, ...rest]);
        };
        XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
            if (!targets.has(this) || !(body instanceof FormData)) return send.call(this, body);
            const media = body.get("content");
            const bytes = media instanceof Blob ? media.size : 0;
            const index = String(body.get("index"));
            const count = (attempts.get(index) ?? 0) + 1;
            attempts.set(index, count);
            // Reserve the remaining unique media and its envelopes as well as
            // this request. Repeated failures cannot silently exceed admission.
            const remaining = Math.max(0, sizeBytes - acceptedBytes - bytes);
            const futureEnvelopes = (Math.ceil(remaining / effectiveChunkBytes) + 1) * envelope;
            const claim = state.claimedBytes + bytes + envelope;
            if (count > 3 || claim + remaining + futureEnvelopes > limit) {
                state.failure = count > 3 ? `chunk ${index} failed after three attempts`
                    : "chunk retry allowance exhausted; upload budget preserved";
                return;
            }
            state.claimedBytes = claim;
            const xhr = this;
            let loaded = 0, movedAt = Date.now(), timer: ReturnType<typeof setInterval> | undefined;
            xhr.upload.addEventListener("progress", event => {
                if (event.loaded > loaded) {
                    state.bytesObserved += event.loaded - loaded;
                    loaded = event.loaded; movedAt = Date.now();
                }
            });
            xhr.addEventListener("readystatechange", () => {
                if (xhr.readyState !== XMLHttpRequest.DONE) return;
                if (timer) clearInterval(timer);
                try {
                    if (xhr.status === 200 && JSON.parse(xhr.responseText).status === "success" && !accepted.has(index)) {
                        accepted.add(index); acceptedBytes += bytes; state.acceptedPayloadBytes = acceptedBytes; state.acceptedChunks++;
                    }
                } catch { /* The ordinary response validator reports errors. */ }
            });
            // Persist first, then start the real request. No request body is
            // buffered or rewritten; KVS still owns its FormData and retry.
            void w.__pipelineClaimChunk(Math.max(sizeBytes, claim)).then(() => {
                if (xhr.readyState !== XMLHttpRequest.OPENED || state.failure) return;
                movedAt = Date.now();
                // Index zero assembles accepted chunks on the server. It has no
                // media to send and uses the enclosing ten-minute deadline.
                // Replaying an assembly request after one minute is unsafe.
                if (bytes > 0) timer = setInterval(() => {
                    if (Date.now() - movedAt < idleMs) return;
                    clearInterval(timer);
                    state.abortedChunks++;
                    xhr.abort(); // KVS retries this index, retaining earlier chunks.
                }, Math.max(10, Math.min(1000, idleMs / 4)));
                send.call(xhr, body);
            }).catch(() => { state.failure = "could not persist upload chunk allowance"; if (timer) clearInterval(timer); xhr.abort(); });
        };
    }, { sizeBytes, limit, chunkBytes: options.chunkBytes ?? PORNTREX_CHUNK_BYTES,
        idleMs: options.idleMs ?? PORNTREX_CHUNK_IDLE_MS, envelope: ENVELOPE_ALLOWANCE });
}

export async function readPorntrexTransfer(page: Page): Promise<PorntrexTransferState | null> {
    // The successful metadata redirect replaces this document and its state.
    return await page.evaluate(() => (window as unknown as { __pipelineTransfer?: PorntrexTransferState }).__pipelineTransfer ?? null);
}
