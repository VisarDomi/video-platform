import { lstat } from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { ChromiumPorntrexUploader } from "../upload/chromiumPorntrexUploader.js";
import { createProviderUploader } from "../upload/providerFactory.js";
import { checkPorntrexSession, type SessionCheck } from "../upload/porntrexKeepalive.js";
import { readPorntrexSession, sessionFingerprint, sharedSessionCookies, type StoredCookie } from "../upload/porntrexSession.js";
import { PtrexPhone, type PhoneSessionResult } from "../phone/ptrexPhone.js";

const IDLE_WAIT_MILLISECONDS = 2 * 60 * 60_000;

export interface ConnectDependencies {
    readonly openPipelineSession: () => Promise<void>;
    readonly connectPhone: (cookies: readonly StoredCookie[]) => Promise<PhoneSessionResult>;
    readonly checkSession: (sessionFile: string) => Promise<SessionCheck>;
    readonly pause: (milliseconds: number) => Promise<void>;
    readonly log: (message: string) => void;
}

function defaultDependencies(config: PipelineConfig): ConnectDependencies {
    return {
        openPipelineSession: async () => {
            const uploader = await createProviderUploader({ ...config, uploadProvider: "porntrex" }, "porntrex") as ChromiumPorntrexUploader;
            // The one place allowed to log in: it is what the phone is about to share.
            await uploader.withAuthenticatedPage(async () => undefined, { allowPasswordLogin: true });
        },
        connectPhone: (cookies) => new PtrexPhone().connect(cookies),
        checkSession: (file) => checkPorntrexSession(file),
        pause: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        log: (message) => console.error(message),
    };
}

async function profileInUse(profilePath: string): Promise<boolean> {
    // Chromium holds this symlink while a browser uses the profile.
    return await lstat(path.join(profilePath, "SingletonLock")).then(() => true, () => false);
}

// `npm run ptrex:connect-iphone`: one Porntrex login shared by the pipeline and
// the phone. Ensures the pipeline's session is logged in (logging in only if
// it is not), copies that session into the Video Vault app, checks both, and resumes
// the campaign if it was running or stopped for a lost session.
export async function connectPorntrexPhone(config: PipelineConfig, dependencies = defaultDependencies(config)): Promise<unknown> {
    const sessionFile = config.porntrexSessionPath;
    if (!sessionFile) throw new Error("No Porntrex session file is configured");
    let database = new PipelineDatabase(config.databasePath);
    let resumeAfter: boolean;
    try {
        const control = database.getCampaignControl();
        resumeAfter = control.state === "running" || (control.attentionReason?.includes("ptrex:connect-iphone") ?? false);
        // No new upload may start while the shared session is being replaced.
        if (control.state === "running") database.setCampaignState("paused");
    } finally { database.close(); }

    const started = Date.now();
    for (;;) {
        database = new PipelineDatabase(config.databasePath);
        let uploading: boolean;
        try { uploading = database.listActiveUploadAttempts().length > 0; } finally { database.close(); }
        const profile = config.porntrexBrowserProfilePath ?? config.browserProfilePath;
        if (!uploading && !await profileInUse(profile)) break;
        if (Date.now() - started > IDLE_WAIT_MILLISECONDS) throw new Error("An upload or browser kept the pipeline profile busy for two hours; try again later");
        dependencies.log(uploading ? "Waiting for the current upload to finish..." : "Waiting for the pipeline browser to close...");
        await dependencies.pause(15_000);
    }

    const before = await readPorntrexSession(sessionFile);
    await dependencies.openPipelineSession();
    const session = await readPorntrexSession(sessionFile);
    if (!session) throw new Error("The pipeline did not store a Porntrex session");
    const fingerprint = sessionFingerprint(session.cookies);
    const loggedInAgain = session.passwordLoginAt !== before?.passwordLoginAt;
    database = new PipelineDatabase(config.databasePath);
    try {
        if (loggedInAgain) database.recordProviderSessionEvent({ provider: "porntrex", kind: "password_login", loggedIn: true,
            fingerprint, passwordLoginAt: session.passwordLoginAt, note: "pipeline logged in for ptrex:connect-iphone" });
    } finally { database.close(); }

    dependencies.log("Copying the pipeline's Porntrex session into Video Vault on the iPhone...");
    const phone = await dependencies.connectPhone(sharedSessionCookies(session.cookies));
    const pipeline = await dependencies.checkSession(sessionFile);
    database = new PipelineDatabase(config.databasePath);
    try {
        database.recordProviderSessionEvent({ provider: "porntrex", kind: "phone_connected", loggedIn: phone.loggedIn && pipeline.loggedIn,
            fingerprint, passwordLoginAt: session.passwordLoginAt,
            note: `phone ${phone.loggedIn ? "logged in" : `not logged in (${phone.host}${phone.finalPath})`}; pipeline ${pipeline.loggedIn ? "logged in" : pipeline.note}` });
        if (!phone.loggedIn || !pipeline.loggedIn) {
            throw new Error(`Shared session not established: phone ${phone.loggedIn ? "ok" : `not logged in (${phone.host}${phone.finalPath})`}, `
                + `pipeline ${pipeline.loggedIn ? "ok" : pipeline.note}. The campaign stays paused.`);
        }
        if (resumeAfter) database.setCampaignState("running");
        return {
            sharedSession: fingerprint,
            passwordLoginAt: session.passwordLoginAt,
            loggedInAgain,
            phone: "logged in on the shared session",
            pipeline: "logged in on the shared session",
            campaign: database.getCampaignControl().state,
        };
    } finally { database.close(); }
}
