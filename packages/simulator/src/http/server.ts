// A small HTTP(S) layer: routing, cookies, bodies, and one ground-truth
// response record per request.
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { sha256 } from "../rng.js";
import type { ResponseRecord, TruthSink } from "../truth/log.js";

export interface Reply {
    status: number | "reset";
    body?: Buffer | string;
    headers?: Record<string, string | string[]>;
    /** Response kind for the log: master, media, segment, init, api, auth, page, control... */
    kind?: string;
    /** Extra fields for the response record. */
    log?: Partial<ResponseRecord>;
    /** Hash the body into the response record (segments). */
    hashBody?: boolean;
    /**
     * A streamed body instead of `body` (large files, throttled or stalled
     * transfers). `length` is announced as content-length; `write` resolves
     * with the bytes it actually sent. The response record is written once it
     * finishes, with `bytes` = what was sent.
     */
    stream?: { length: number; write(res: ServerResponse, req: IncomingMessage): Promise<number> };
}

export interface RequestContext {
    req: IncomingMessage;
    url: URL;
    params: Record<string, string>;
    cookies: Record<string, string>;
    now: number;
    body(): Promise<Buffer>;
    json<T = unknown>(): Promise<T>;
    /** Form fields from a urlencoded body, or a JSON object body. */
    fields(): Promise<Record<string, string>>;
    /** Every form field, repeated ones included (urlencoded or multipart). */
    form(): Promise<URLSearchParams>;
    /** A multipart/form-data body: text fields and files. */
    multipart(): Promise<Multipart>;
}

export interface Multipart {
    fields: URLSearchParams;
    files: Map<string, { filename: string; type: string; data: Buffer }>;
}

export type Handler = (ctx: RequestContext) => Promise<Reply> | Reply;

export interface RouteOptions {
    /** Largest request body accepted (default 1 MiB); larger ones get 413. */
    maxBodyBytes?: number;
}

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; options: RouteOptions }

export class HttpError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

export class Router {
    private readonly routes: Route[] = [];

    on(method: string, path: string, handler: Handler, options: RouteOptions = {}): this {
        const keys: string[] = [];
        const source = path.split("/").map(part => {
            if (part.startsWith(":")) { keys.push(part.slice(1)); return "([^/]+)"; }
            return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }).join("/");
        this.routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler, options });
        return this;
    }

    get(path: string, handler: Handler): this { return this.on("GET", path, handler); }
    post(path: string, handler: Handler, options?: RouteOptions): this { return this.on("POST", path, handler, options); }
    put(path: string, handler: Handler, options?: RouteOptions): this { return this.on("PUT", path, handler, options); }
    patch(path: string, handler: Handler): this { return this.on("PATCH", path, handler); }
    delete(path: string, handler: Handler): this { return this.on("DELETE", path, handler); }

    match(method: string, path: string): { handler: Handler; params: Record<string, string>; options: RouteOptions } | "method" | null {
        let methodMismatch = false;
        for (const route of this.routes) {
            const m = route.pattern.exec(path);
            if (!m) continue;
            if (route.method !== method && !(route.method === "GET" && method === "HEAD")) { methodMismatch = true; continue; }
            const params: Record<string, string> = {};
            route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
            return { handler: route.handler, params, options: route.options };
        }
        return methodMismatch ? "method" : null;
    }
}

export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (header ?? "").split(";")) {
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
    return out;
}

export function setCookie(name: string, value: string, options: { maxAgeS?: number; httpOnly?: boolean; path?: string } = {}): string {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`, "SameSite=Lax"];
    if (options.maxAgeS !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeS))}`);
    if (options.httpOnly) parts.push("HttpOnly");
    return parts.join("; ");
}

export const json = (status: number, value: unknown, extra: Partial<Reply> = {}): Reply =>
    ({ status, body: JSON.stringify(value), ...extra, headers: { "content-type": "application/json", ...(extra.headers ?? {}) } });

export const text = (status: number, body: string, type = "text/plain; charset=utf-8", extra: Partial<Reply> = {}): Reply =>
    ({ status, body, ...extra, headers: { "content-type": type, ...(extra.headers ?? {}) } });

export const html = (status: number, body: string, extra: Partial<Reply> = {}): Reply =>
    text(status, body, "text/html; charset=utf-8", { kind: "page", ...extra });

export const playlist = (body: string, extra: Partial<Reply> = {}): Reply =>
    text(200, body, "application/vnd.apple.mpegurl", extra);

const MAX_BODY = 1024 * 1024;

/** Parses a multipart/form-data body (RFC 7578): text fields and files. */
export function parseMultipart(body: Buffer, contentType: string): Multipart {
    const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    if (!m) throw new HttpError(400, "multipart body without a boundary");
    const delimiter = Buffer.from(`--${m[1] ?? m[2]}`);
    const out: Multipart = { fields: new URLSearchParams(), files: new Map() };
    let pos = body.indexOf(delimiter);
    if (pos < 0) throw new HttpError(400, "malformed multipart body");
    for (;;) {
        pos += delimiter.length;
        if (body.subarray(pos, pos + 2).toString() === "--") break;
        pos += 2; // CRLF after the delimiter
        const headerEnd = body.indexOf("\r\n\r\n", pos);
        if (headerEnd < 0) throw new HttpError(400, "malformed multipart part");
        const headers = body.subarray(pos, headerEnd).toString("utf8");
        const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), headerEnd + 4);
        if (next < 0) throw new HttpError(400, "unterminated multipart body");
        const data = body.subarray(headerEnd + 4, next);
        const disposition = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] ?? "";
        const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
        const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
        if (name !== undefined) {
            if (filename !== undefined) {
                out.files.set(name, { filename, type: /content-type:\s*([^\r\n]*)/i.exec(headers)?.[1]?.trim() ?? "application/octet-stream", data: Buffer.from(data) });
            } else {
                out.fields.append(name, data.toString("utf8"));
            }
        }
        pos = next + 2;
    }
    return out;
}

function makeContext(req: IncomingMessage, url: URL, params: Record<string, string>, now: number, maxBody = MAX_BODY): RequestContext {
    let cached: Promise<Buffer> | null = null;
    const body = () => cached ??= new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > maxBody) { reject(new HttpError(413, "body too large")); req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
    const ctx: RequestContext = {
        req, url, params, now,
        cookies: parseCookies(req.headers.cookie),
        body,
        async json<T>() {
            const raw = (await body()).toString();
            try { return JSON.parse(raw) as T; } catch { throw new HttpError(400, "invalid JSON body"); }
        },
        async fields() {
            const raw = (await body()).toString();
            const type = req.headers["content-type"] ?? "";
            if (type.includes("application/json")) {
                let v: unknown;
                try { v = JSON.parse(raw); } catch { throw new HttpError(400, "invalid JSON body"); }
                if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HttpError(400, "expected a JSON object");
                return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
            }
            return Object.fromEntries(new URLSearchParams(raw));
        },
        async form() {
            const type = req.headers["content-type"] ?? "";
            if (type.includes("multipart/form-data")) return (await ctx.multipart()).fields;
            return new URLSearchParams((await body()).toString());
        },
        async multipart() {
            const type = req.headers["content-type"] ?? "";
            if (!type.includes("multipart/form-data")) throw new HttpError(400, "expected multipart/form-data");
            return parseMultipart(await body(), type);
        },
    };
    return ctx;
}

export interface ServerOptions {
    site: string;
    router: Router;
    truth: TruthSink;
    now: () => number;
    tls?: { cert: string; key: string };
    /** Paths whose query string must not reach the log (tokens). */
    logQuery?: boolean;
}

export function createSiteServer(options: ServerOptions): http.Server {
    const listener = async (req: IncomingMessage, res: ServerResponse) => {
        const now = options.now();
        const url = new URL(req.url ?? "/", "http://sim.local");
        const method = req.method ?? "GET";
        let reply: Reply;
        try {
            const found = options.router.match(method, url.pathname);
            if (found === null) reply = json(404, { error: "not found" }, { kind: "unknown" });
            else if (found === "method") reply = json(405, { error: "method not allowed" }, { kind: "unknown" });
            else reply = await found.handler(makeContext(req, url, found.params, now, found.options.maxBodyBytes));
        } catch (error) {
            reply = error instanceof HttpError
                ? json(error.status, { error: error.message }, { kind: "error" })
                : json(500, { error: "internal error" }, { kind: "error", log: { reason: String((error as Error)?.message ?? error) } });
        }
        const body = reply.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body);
        const record: ResponseRecord = {
            type: "response", t: now, site: options.site, method,
            path: url.pathname + (options.logQuery && url.search ? url.search : ""),
            status: reply.status, kind: reply.kind ?? "other", bytes: reply.status === "reset" ? 0 : body.length,
            ...(reply.hashBody && reply.status !== "reset" ? { sha256: sha256(body) } : {}),
            ...(reply.log ?? {}),
        };
        if (reply.status === "reset") {
            options.truth.append(record);
            req.socket.destroy();
            return;
        }
        res.statusCode = reply.status;
        for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
        if (!res.hasHeader("cache-control")) res.setHeader("cache-control", "no-cache");
        if (reply.stream && method !== "HEAD") {
            res.setHeader("content-length", reply.stream.length);
            let sent = 0;
            try {
                sent = await reply.stream.write(res, req);
            } finally {
                options.truth.append({ ...record, bytes: sent, planned: reply.stream.length } as ResponseRecord);
            }
            return;
        }
        options.truth.append(record);
        res.setHeader("content-length", reply.stream ? reply.stream.length : body.length);
        res.end(method === "HEAD" ? undefined : body);
    };
    const server = options.tls
        ? https.createServer({ cert: readFileSync(options.tls.cert), key: readFileSync(options.tls.key) }, listener)
        : http.createServer(listener);
    server.keepAliveTimeout = 5000;
    return server;
}

export function listen(server: http.Server, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve((server.address() as AddressInfo).port);
        });
    });
}

export function close(server: http.Server): Promise<void> {
    return new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
    });
}
