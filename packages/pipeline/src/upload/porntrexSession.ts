import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Porntrex keeps one active session per account and the newest login wins,
// so the pipeline and the phone app must share a single session instead of
// each logging in. This private file (chmod 600) is the pipeline's copy of it.
// The PHP session cookie alone carries the login; `confirmed` is the 18+ gate.
// It deliberately never holds kt_member: signing back in with that token
// starts a new session and logs every other device out.
export interface StoredCookie {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly expires: number;
    readonly httpOnly: boolean;
    readonly secure: boolean;
    readonly sameSite: "Strict" | "Lax" | "None";
}

export interface PorntrexSession {
    readonly version: 1;
    readonly cookies: readonly StoredCookie[];
    // When the shared session was created by a password login. Its age is
    // what the session report watches (does porntrex end sessions by age?).
    readonly passwordLoginAt: string;
    readonly savedAt: string;
}

export const SHARED_SESSION_COOKIES = ["PHPSESSID", "confirmed"] as const;
export const PORNTREX_LOGIN_TOKEN = "kt_member";
// Browsers drop a cookie at its Expires; the server decides validity. Keep
// both cookies for Chromium's maximum lifetime so only the server can end it.
const PINNED_SECONDS = 400 * 24 * 60 * 60;

export function pinCookies(cookies: readonly StoredCookie[], now = new Date()): StoredCookie[] {
    const expires = Math.floor(now.getTime() / 1000) + PINNED_SECONDS;
    return cookies.map((cookie) => ({ ...cookie, expires }));
}

export function sharedSessionCookies(cookies: readonly StoredCookie[]): StoredCookie[] {
    return cookies.filter((cookie) => (SHARED_SESSION_COOKIES as readonly string[]).includes(cookie.name));
}

// Identifies a session in logs and reports without revealing it.
export function sessionFingerprint(cookies: readonly StoredCookie[]): string | null {
    const session = cookies.find((cookie) => cookie.name === "PHPSESSID");
    return session ? createHash("sha256").update(session.value).digest("hex").slice(0, 12) : null;
}

export async function readPorntrexSession(filePath: string): Promise<PorntrexSession | null> {
    let info;
    try { info = await stat(filePath); } catch { return null; }
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("Porntrex session file must be private (chmod 600)");
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(filePath, "utf8")); } catch {
        // Parser messages can quote the file; never echo session values.
        throw new Error("Porntrex session file is not valid JSON");
    }
    const session = parsed as PorntrexSession;
    if (session?.version !== 1 || !Array.isArray(session.cookies) || typeof session.passwordLoginAt !== "string") {
        throw new Error("Porntrex session file has an unexpected shape");
    }
    return session;
}

export async function writePorntrexSession(filePath: string, session: PorntrexSession): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
}
