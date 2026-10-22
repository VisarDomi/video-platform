import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { notifyDesktop } from "../notify.js";
import { checkPorntrexSession, type SessionCheck } from "../upload/porntrexKeepalive.js";

interface Dependencies {
    check: (sessionFile: string) => Promise<SessionCheck>;
    notify: (title: string, message: string) => unknown;
}

// Authentication is independent of conversion/upload lifetime. This job does
// one cookie-only request and never logs in, starts work or changes campaign
// intent. While the worker is alive, its existing keep-alive owns the request.
export async function maintainPorntrexSession(config: Pick<PipelineConfig, "databasePath" | "porntrexSessionPath">,
    now = new Date(), dependencies: Dependencies = { check: checkPorntrexSession,
        notify: (title, message) => notifyDesktop(title, message, true) }): Promise<{
            disposition: "worker_active" | "not_configured" | "logged_in" | "logged_out" | "unavailable";
            fingerprint?: string | null;
            note?: string;
        }> {
    if (!config.porntrexSessionPath) return { disposition: "not_configured" };
    const database = new PipelineDatabase(config.databasePath);
    try {
        if (database.campaignIsActive(now)) return { disposition: "worker_active" };
        const previous = database.listProviderSessionEvents("porntrex").filter(e => e.kind === "keepalive").at(-1);
        let result: SessionCheck;
        try {
            result = await dependencies.check(config.porntrexSessionPath);
        } catch (error) {
            const note = error instanceof Error ? error.message : String(error);
            database.recordProviderSessionEvent({ provider: "porntrex", kind: "keepalive_error", note }, now);
            return { disposition: "unavailable", note };
        }
        database.recordProviderSessionEvent({ provider: "porntrex", kind: "keepalive", loggedIn: result.loggedIn,
            fingerprint: result.fingerprint, passwordLoginAt: result.passwordLoginAt,
            note: `${result.note}; independent session maintenance` }, now);
        if (!result.loggedIn && previous?.loggedIn !== false) {
            dependencies.notify("Porntrex shared session needs recovery",
                "The phone and PC share this session. Restore it together; upload processing remains unchanged.");
        }
        return { disposition: result.loggedIn ? "logged_in" : "logged_out", fingerprint: result.fingerprint, note: result.note };
    } finally { database.close(); }
}
