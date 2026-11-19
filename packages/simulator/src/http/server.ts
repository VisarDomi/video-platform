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
}

export type Handler = (ctx: RequestContext) => Promise<Reply> | Reply;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

export class HttpError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

export class Router {
    private readonly routes: Route[] = [];

    on(method: string, path: string, handler: Handler): this {
        const keys: string[] = [];
        const source = path.split("/").map(part => {
            if (part.startsWith(":")) { keys.push(part.slice(1)); return "([^/]+)"; }
            return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }).join("/");
        this.routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
        return this;
    }

    get(path: string, handler: Handler): this { return this.on("GET", path, handler); }
    post(path: string, handler: Handler): this { return this.on("POST", path, handler); }

    match(method: string, path: string): { handler: Handler; params: Record<string, string> } | "method" | null {
        let methodMismatch = false;
        for (const route of this.routes) {
            const m = route.pattern.exec(path);
            if (!m) continue;
            if (route.method !== method && !(route.method === "GET" && method === "HEAD")) { methodMismatch = true; continue; }
            const params: Record<string, string> = {};
            route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
            return { handler: route.handler, params };
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

function makeContext(req: IncomingMessage, url: URL, params: Record<string, string>, now: number): RequestContext {
    let cached: Promise<Buffer> | null = null;
    const body = () => cached ??= new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) { reject(new HttpError(413, "body too large")); req.destroy(); return; }
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
            else reply = await found.handler(makeContext(req, url, found.params, now));
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
        options.truth.append(record);
        if (reply.status === "reset") {
            req.socket.destroy();
            return;
        }
        res.statusCode = reply.status;
        for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
        res.setHeader("content-length", body.length);
        res.setHeader("cache-control", "no-cache");
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
