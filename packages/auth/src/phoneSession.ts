import "dotenv/config";
import * as fs from "fs";
import { getConfig } from "./common/config.js";
import { parseJwtPayload } from "./auth/authUtils.js";
import { extractTokens } from "./providers/tango/tangoLogin.js";

// A new Tango session for the iPhone app (packages/server phone-session.routes.ts): one Google
// login in a fresh browser context, which is discarded afterwards, so the phone holds its own
// refresh token. The PC's own session (`video-auth`, the session file) is neither read nor
// written. Prints the new session's cookies as one line, `PHONE-SESSION <json>` (the login's
// log lines also go to stdout).
async function main(): Promise<void> {
    const { accountsPath } = getConfig();
    const accounts = (JSON.parse(fs.readFileSync(accountsPath, "utf-8")).accounts ?? []) as { email: string; password: string; provider?: string }[];
    const account = accounts.find(entry => (entry.provider ?? "tango") === "tango");
    if (!account) throw new Error("No Tango account is configured");
    const tokens = await extractTokens({ email: account.email, password: account.password, provider: "tango" });
    if (!tokens?.refreshToken || !tokens.sessionToken) throw new Error("The Tango login did not finish");
    const { refreshToken, sessionToken } = tokens;
    const expiry = (token: string, fallbackDays: number) => {
        const exp = parseJwtPayload(token)?.exp;
        return typeof exp === "number" ? exp : Math.floor(Date.now() / 1000) + fallbackDays * 86_400;
    };
    const cookie = (name: string, value: string, expires: number) => ({ name, value, domain: "gateway.tango.me", path: "/", expires });
    process.stdout.write("\nPHONE-SESSION " + JSON.stringify({ cookies: [
        cookie("Tango-RT", refreshToken, expiry(refreshToken, 90)),
        cookie("Tango-ST", sessionToken, expiry(sessionToken, 1 / 24)),
    ] }) + "\n");
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
