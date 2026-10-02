import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { readPorntrexSession, sessionFingerprint, writePorntrexSession, type StoredCookie } from "./porntrexSession.js";

// Node tries each address family for only 250 ms by default. While an upload
// fills the line, the IPv4 handshake takes longer and the (unavailable) IPv6
// fallback then fails the whole request. Give a connection a realistic time.
setDefaultAutoSelectFamilyAttemptTimeout(3_000);

const ORIGIN = "https://www.porntrex.com";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export interface SessionCheck {
    readonly loggedIn: boolean;
    readonly fingerprint: string | null;
    readonly passwordLoginAt: string | null;
    readonly note: string;
}

// One light request on the shared session, without a browser. It keeps the
// server-side session from idling out and tells whether it is still ours.
// kt_member is never sent: it would start a new session and log others out.
export async function checkPorntrexSession(
    sessionFilePath: string,
    fetchImpl: typeof fetch = fetch,
    origin = ORIGIN,
): Promise<SessionCheck> {
    const session = await readPorntrexSession(sessionFilePath);
    if (!session) return { loggedIn: false, fingerprint: null, passwordLoginAt: null, note: "no shared session stored" };
    const cookieHeader = session.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const request = () => fetchImpl(`${origin}/upload-video/`, {
        headers: { cookie: cookieHeader, "user-agent": USER_AGENT, accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
    });
    let response: Response;
    try {
        // One retry: a single network blip is common and says nothing about the login.
        response = await request().catch(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            return await request();
        });
    } catch (error) {
        // Unreachable is not logged out: report it, do not stop the pipeline.
        const cause = (error as { cause?: { code?: string } }).cause?.code;
        throw new Error(`Porntrex session check could not reach the site: ${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ""}`);
    }
    const body = response.status === 200 ? await response.text() : "";
    const loggedIn = response.status === 200 && /name="content"/.test(body);
    // A logged-out session is redirected to the home page.
    const note = loggedIn ? "upload form served" : response.status >= 300 && response.status < 400
        ? `redirected to ${new URL(response.headers.get("location") ?? "/", origin).pathname}` : `HTTP ${response.status}`;
    const rotated = rotatedSession(response, session.cookies);
    if (rotated) {
        await writePorntrexSession(sessionFilePath, { ...session, cookies: rotated, savedAt: new Date().toISOString() });
    }
    return {
        loggedIn,
        fingerprint: sessionFingerprint(rotated ?? session.cookies),
        passwordLoginAt: session.passwordLoginAt,
        note: rotated ? `${note}; server issued a new PHP session ID` : note,
    };
}

function rotatedSession(response: Response, cookies: readonly StoredCookie[]): StoredCookie[] | null {
    const issued = response.headers.getSetCookie?.() ?? [];
    const value = issued.map((line) => line.match(/^PHPSESSID=([^;]+)/)?.[1]).find(Boolean);
    const current = cookies.find((cookie) => cookie.name === "PHPSESSID");
    if (!value || !current || value === current.value || value === "deleted") return null;
    return cookies.map((cookie) => cookie.name === "PHPSESSID" ? { ...cookie, value } : cookie);
}

// Read-only page request on the shared session (same cookies as the
// keep-alive, never kt_member). For reports; it never logs in.
export async function porntrexGet(sessionFilePath: string, pathname: string, fetchImpl: typeof fetch = fetch, origin = ORIGIN):
    Promise<{ status: number; location: string | null; html: string }> {
    const session = await readPorntrexSession(sessionFilePath);
    if (!session) throw new Error("No shared Porntrex session stored; run `npm run ptrex:connect-iphone`");
    const response = await fetchImpl(`${origin}${pathname}`, {
        headers: { cookie: session.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "), "user-agent": USER_AGENT, accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, location: response.headers.get("location"), html: response.status === 200 ? await response.text() : "" };
}
