// Serving files from disk with byte ranges, and the transfer faults a
// downloader must survive: a throttled body, a body that stops arriving, and
// a connection cut partway.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import type { Reply } from "./server.js";

export interface RangePlan {
    status: 200 | 206 | 416;
    /** First and last byte (inclusive) of the body. */
    start: number;
    end: number;
    length: number;
    headers: Record<string, string>;
}

/**
 * Applies `Range` (a single range; several are answered with the whole file,
 * as RFC 9110 allows) and `If-Range` (a different validator gets the whole
 * file, so a resume never mixes two versions).
 */
export function planRange(size: number, headers: { range?: string; ifRange?: string }, validators: { etag: string; lastModified?: string }): RangePlan {
    const base: Record<string, string> = { "accept-ranges": "bytes", etag: validators.etag, ...(validators.lastModified ? { "last-modified": validators.lastModified } : {}) };
    const whole: RangePlan = { status: 200, start: 0, end: size - 1, length: size, headers: base };
    const range = headers.range?.trim();
    if (!range) return whole;
    if (headers.ifRange !== undefined && headers.ifRange !== validators.etag && headers.ifRange !== validators.lastModified) return whole;
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === "" && m[2] === "")) return whole;
    let start: number, end: number;
    if (m[1] === "") {
        const suffix = Number(m[2]);
        if (suffix === 0) return { status: 416, start: 0, end: -1, length: 0, headers: { ...base, "content-range": `bytes */${size}` } };
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(m[1]);
        end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
        if (start >= size || end < start) return { status: 416, start: 0, end: -1, length: 0, headers: { ...base, "content-range": `bytes */${size}` } };
    }
    return { status: 206, start, end, length: end - start + 1, headers: { ...base, "content-range": `bytes ${start}-${end}/${size}` } };
}

export interface TransferShape {
    /** slow: throttle to bytesPerSecond; stall: stop sending after afterBytes; cut: close the connection after afterBytes. */
    mode: "slow" | "stall" | "cut";
    afterBytes?: number;
    bytesPerSecond?: number;
    /** stall: how long to hold the connection before closing it (default: until the client gives up). */
    stallMs?: number;
}

const CHUNK = 64 * 1024;

/** A streamed reply body for bytes [start, end] of a file, shaped by an optional fault. */
export function fileStream(path: string, start: number, end: number, shape?: TransferShape): NonNullable<Reply["stream"]> {
    const length = Math.max(0, end - start + 1);
    return {
        length,
        async write(res: ServerResponse): Promise<number> {
            let closed = false;
            res.on("close", () => { closed = true; });
            const handle = await open(path, "r");
            let sent = 0;
            try {
                const buffer = Buffer.alloc(CHUNK);
                const began = Date.now();
                const limit = shape && shape.mode !== "slow" ? Math.min(length, shape.afterBytes ?? 0) : length;
                const throttle = shape?.mode === "slow" && shape.bytesPerSecond ? shape.bytesPerSecond : null;
                // Throttled: pieces of about a tenth of a second each.
                const pieceSize = throttle ? Math.max(1024, Math.min(CHUNK, Math.floor(throttle / 10))) : CHUNK;
                while (sent < limit && !closed) {
                    const n = Math.min(pieceSize, limit - sent);
                    if (throttle) {
                        // Send a piece only once the rate has earned it.
                        const wait = began + ((sent + n) / throttle) * 1000 - Date.now();
                        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
                        if (closed) break;
                    }
                    const { bytesRead } = await handle.read(buffer, 0, n, start + sent);
                    if (bytesRead === 0) break;
                    const piece = Buffer.from(buffer.subarray(0, bytesRead));
                    // Wait until the piece reached the socket, so a cut or a
                    // stall right after it really delivered these bytes.
                    await new Promise<void>(resolve => res.write(piece, () => resolve()));
                    sent += bytesRead;
                }
                if (closed) return sent;
                if (shape?.mode === "cut" && sent < length) {
                    res.socket?.destroy();
                    return sent;
                }
                if (shape?.mode === "stall" && sent < length) {
                    await new Promise<void>(resolve => {
                        const timer = shape.stallMs !== undefined ? setTimeout(resolve, shape.stallMs) : null;
                        res.once("close", () => { if (timer) clearTimeout(timer); resolve(); });
                    });
                    res.socket?.destroy();
                    return sent;
                }
                res.end();
                return sent;
            } finally {
                await handle.close();
            }
        },
    };
}

export function sha256File(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(path).on("data", c => hash.update(c)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
    });
}
