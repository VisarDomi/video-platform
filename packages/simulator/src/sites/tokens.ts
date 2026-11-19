// Signed tokens (JWT layout, HS256) for the simulated sites. The secret comes
// from the scenario seed, so tokens survive a restart of the simulator.
import { createHmac, timingSafeEqual } from "node:crypto";

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export interface Claims {
    sub: string;
    exp: number;
    iat: number;
    [key: string]: unknown;
}

export function signToken(secret: string, claims: Claims): string {
    const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64(JSON.stringify(claims));
    const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${sig}`;
}

export type Verified<T extends Claims> = { ok: true; claims: T } | { ok: false; reason: "malformed" | "signature" | "expired"; claims?: T };

/** Checks signature and expiry (`now` in epoch ms; `exp` in epoch seconds). */
export function verifyToken<T extends Claims>(secret: string, token: string | undefined, now: number): Verified<T> {
    const parts = (token ?? "").split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };
    let claims: T;
    try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()); } catch { return { ok: false, reason: "malformed" }; }
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return { ok: false, reason: "expired", claims };
    return { ok: true, claims };
}

/** Reads claims without verifying (what a client does to build a refresh body). */
export function peekClaims<T = Record<string, unknown>>(token: string): T | null {
    try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as T; } catch { return null; }
}

export function mac(secret: string, ...parts: Array<string | number>): string {
    return createHmac("sha256", secret).update(parts.join("|")).digest("hex").slice(0, 32);
}
