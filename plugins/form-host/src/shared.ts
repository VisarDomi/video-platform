import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileDurably, type Destination, type DestinationHost, type SharedSessionSnapshot, type UploadRequest } from "sdk";
import { FormHostDestination, readConfig } from "./destination.js";

// The cookies a companion may use: the session and the consent, never the remember-me
// token (presenting it starts a new session and signs every other one out).
const SHARED = ["sid", "consent"];

interface Jar { cookies: Record<string, string>; passwordLoginAt: string | null }

const jarFile = (stateDir: string) => path.join(stateDir, "session.json");

async function readJar(stateDir: string): Promise<Jar | null> {
    try {
        const saved = JSON.parse(await readFile(jarFile(stateDir), "utf8")) as Partial<Jar>;
        return { cookies: { ...(saved.cookies ?? {}) }, passwordLoginAt: saved.passwordLoginAt ?? null };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error("form-host: the session file is not readable");
    }
}

const fingerprint = (sid: string | undefined) => sid ? createHash("sha256").update(sid).digest("hex").slice(0, 12) : null;

function snapshot(cookies: Record<string, string>, baseUrl: string | null): SharedSessionSnapshot {
    const domain = baseUrl ? new URL(baseUrl).hostname : "";
    return {
        cookies: SHARED.filter((name) => cookies[name]).map((name) => ({ name, value: cookies[name], domain, path: "/", httpOnly: name === "sid" })),
        fingerprint: fingerprint(cookies.sid),
        savedAt: new Date().toISOString(),
    };
}

export async function readSession(stateDir: string | undefined): Promise<SharedSessionSnapshot | null> {
    if (!stateDir) return null;
    const jar = await readJar(stateDir);
    return jar?.cookies.sid ? snapshot(jar.cookies, null) : null;
}

// The session the site replaced during a companion's upload, stored in the jar as the
// destination's own requests store a rotated one.
export async function adoptSession(session: SharedSessionSnapshot, stateDir: string | undefined): Promise<void> {
    if (!stateDir) throw new Error("form-host: adopting a session needs the destination's state folder");
    const jar = await readJar(stateDir) ?? { cookies: {}, passwordLoginAt: null };
    for (const cookie of session.cookies) if (SHARED.includes(cookie.name)) jar.cookies[cookie.name] = cookie.value;
    await writeFileDurably(jarFile(stateDir), JSON.stringify(jar));
}

// A form-host destination on exactly this session: password logins off, nothing but the
// shared cookies in its jar; a replaced session is reported before the upload settles.
export function companionDestination(host: DestinationHost, session: SharedSessionSnapshot,
    onSessionChange: (session: SharedSessionSnapshot) => Promise<void>): Destination {
    const config = readConfig({ ...host.config, allowPasswordLogin: false, rememberMe: false });
    const cookies = Object.fromEntries(session.cookies.filter((cookie) => SHARED.includes(cookie.name)).map((cookie) => [cookie.name, cookie.value]));
    const seeded = writeFileDurably(jarFile(host.stateDir), JSON.stringify({ cookies, passwordLoginAt: null }));
    const destination = new FormHostDestination(config, host);
    const reportChange = async () => {
        const jar = await readJar(host.stateDir);
        if (jar?.cookies.sid && jar.cookies.sid !== cookies.sid) await onSessionChange(snapshot(jar.cookies, config.baseUrl));
    };
    return {
        creationBoundary: destination.creationBoundary,
        session: destination.session,
        findUploadedCopy: async (identity) => { await seeded; return destination.findUploadedCopy(identity); },
        withSession: async (action) => { await seeded; return destination.withSession(action); },
        upload: async (request: UploadRequest) => {
            await seeded;
            try {
                return await destination.upload(request);
            } finally {
                await reportChange();
            }
        },
    };
}
