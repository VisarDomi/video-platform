import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { readPorntrexSession, sessionFingerprint } from "../upload/porntrexSession.js";

const DAY = 24 * 60 * 60_000;
const days = (milliseconds: number) => Math.round(milliseconds / DAY * 10) / 10;

// `npm run ptrex:session-report`: the shared session's history from the
// keep-alive record. It answers whether porntrex ends a session by age (for
// example at kt_member's 30 days) or only when another login replaces it.
export async function porntrexSessionReport(config: PipelineConfig, now = new Date()): Promise<unknown> {
    const session = config.porntrexSessionPath ? await readPorntrexSession(config.porntrexSessionPath) : null;
    const database = new PipelineDatabase(config.databasePath);
    try {
        const events = database.listProviderSessionEvents("porntrex");
        const fingerprint = session ? sessionFingerprint(session.cookies) : null;
        const loginAt = session ? Date.parse(session.passwordLoginAt) : Number.NaN;
        // PHP may reuse its cookie value after a new password login. Cookie
        // identity alone must not mix two different authentication lifetimes.
        const current = events.filter((event) => event.fingerprint === fingerprint
            && Date.parse(event.occurredAt) >= loginAt
            && (!event.passwordLoginAt || event.passwordLoginAt === session?.passwordLoginAt));
        const checks = current.filter((event) => event.kind === "keepalive");
        const ok = checks.filter((event) => event.loggedIn);
        const confirmations = current.filter(event => event.kind === "keepalive"
            || event.kind === "phone_connected" && event.loggedIn === true);
        const lastOk = confirmations.filter(event => event.loggedIn).at(-1)?.occurredAt ?? null;
        const lastCheck = confirmations.at(-1) ?? null;
        const losses = events.filter((event) => event.kind === "lost" || (event.kind === "keepalive" && event.loggedIn === false));
        const firstLoss = losses.find((event) => current.includes(event));
        const alive = lastCheck?.loggedIn === true;
        const fresh = lastCheck !== null && now.getTime() - Date.parse(lastCheck.occurredAt) <= 15 * 60_000;
        const ageAtLastOk = lastOk ? days(Date.parse(lastOk) - loginAt) : null;
        const verdict = !session ? "No shared session yet: run `npm run ptrex:connect-iphone`."
            : !fresh ? `No recent session check; last confirmed logged in at ${lastOk ?? "never"}. Current authentication is unknown.`
            : alive && ageAtLastOk !== null && ageAtLastOk >= 31
                ? `Still logged in ${ageAtLastOk} days after its password login: porntrex does not end sessions at 30 days.`
                : alive ? `Logged in; ${ageAtLastOk ?? 0} days since the password login (30-day question answered after day 31).`
                    : firstLoss ? `Logged out ${days(Date.parse(firstLoss.occurredAt) - loginAt)} days after its password login (${firstLoss.note ?? "no detail"}). `
                        + "The check cannot distinguish idle expiry, an explicit logout or a replacement login."
                        : "Not confirmed logged in yet.";
        return {
            sharedSession: fingerprint,
            passwordLoginAt: session?.passwordLoginAt ?? null,
            ageDays: session ? days(now.getTime() - loginAt) : null,
            currentStatus: !fresh ? "unknown" : alive ? "logged_in" : "logged_out",
            keepalive: {
                checks: checks.length,
                loggedIn: ok.length,
                lastCheckAt: lastCheck?.occurredAt ?? null,
                lastCheckKind: lastCheck?.kind ?? null,
                lastResult: lastCheck ? (lastCheck.loggedIn ? "logged in" : lastCheck.note) : null,
                lastLoggedInAt: lastOk,
                errors: current.filter((event) => event.kind === "keepalive_error").length,
            },
            connects: events.filter((event) => event.kind === "phone_connected" || event.kind === "password_login")
                .slice(-10).map(({ occurredAt, kind, fingerprint: id, note }) => ({ occurredAt, kind, session: id, note })),
            losses: losses.slice(-10).map(({ occurredAt, fingerprint: id, note }) => ({ occurredAt, session: id, note })),
            campaign: database.getCampaignControl().attentionReason ?? database.getCampaignControl().state,
            verdict,
        };
    } finally {
        database.close();
    }
}
