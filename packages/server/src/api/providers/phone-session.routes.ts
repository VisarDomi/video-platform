import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Router, json, type Request } from "express";
import type { SiteAccount, SiteAuth } from "sdk";
import { authAccountsPath } from "shared";
import { SHARED_STATE_PATH } from "../../core/config.js";

// A live app's shortcut to a login (the iOS live app's PC login): the PC
// signs in with a separate browser profile (the site's auth.provisionDevice) and hands the
// phone that new session, so every device holds its own refresh token; the PC's own session
// is never shared. Served as /api/<site>/phone-session for every site whose auth provisions
// devices. Callers need the phone key (`<site>-phone-key` in the shared state folder, built
// into the app); one login runs at a time. Tokens are never logged.
export interface PhoneSite {
    // The site ID (route segment, key and receipt file names) and its plug-in's label.
    id: string;
    label: string;
}

export const phoneKeyPath = (site: Pick<PhoneSite, "id">): string => path.join(SHARED_STATE_PATH, `${site.id}-phone-key`);

export interface PhoneSessionDependencies {
    key(): string | null;
    available(): boolean;
    login(requestId?:string): Promise<{ cookies: unknown[] }>;
    retained?(requestId: string): {cookies: unknown[]} | null;
    retain?(requestId: string, result: {cookies: unknown[]}): void;
    acknowledge?(requestId: string): void | Promise<void>;
}

export function phoneKey(file: string): string {
    if (!existsSync(file)) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    }
    return readFileSync(file, "utf-8").trim();
}

// The account the phone signs in with: the site's account in the auth daemon's accounts
// file (an account without a site belongs to the first site with auth).
async function phoneAccount(site: PhoneSite, accountsPath: string, firstAuthSite: string): Promise<SiteAccount> {
    const configured = JSON.parse(await readFile(accountsPath, "utf8")).accounts as (SiteAccount & { provider?: string })[];
    const account = configured.find(a => (a.provider ?? firstAuthSite) === site.id);
    if (!account) throw new Error(`No ${site.label} account is configured`);
    return account;
}

export function phoneSessionDependencies(site: PhoneSite, auth: Required<Pick<SiteAuth, "provisionDevice">> & Pick<SiteAuth, "acknowledgeDevice">,
    firstAuthSite: string): PhoneSessionDependencies {
    const accounts = authAccountsPath();
    const receipt = path.join(SHARED_STATE_PATH, `${site.id}-phone-handoff.json`);
    const held = () => { try { return JSON.parse(readFileSync(receipt, "utf8")) as {id:string;time:number;result:{cookies:unknown[]}}; } catch (error: any) { if(error.code==="ENOENT") return null; throw error; } };
    return {
        key: () => { try { return phoneKey(phoneKeyPath(site)); } catch { return null; } },
        available: () => existsSync(accounts),
        retained: id => { const value=held(); return value?.id===id ? value.result : null; },
        retain: (id,result) => {
            writeFileSync(receipt+".tmp", JSON.stringify({id,time:Date.now(),result}), {mode:0o600});
            renameSync(receipt+".tmp",receipt);
        },
        acknowledge: async id => {
            await auth.acknowledgeDevice?.(id);
            if(held()?.id===id)unlinkSync(receipt);
        },
        login: async requestId => {
            // One persistent owner lives with this existing server. Do not create
            // a fresh Google/browser session for each native renewal request. Its browser
            // runs on the Xvfb display, from the browsers installed with Playwright.
            process.env.DISPLAY ??= ":111";
            process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
            const account = await phoneAccount(site, accounts, firstAuthSite);
            return auth.provisionDevice(account, requestId??randomBytes(16).toString("hex"));
        },
    };
}

export function createPhoneSessionRoutes(site: PhoneSite, dependencies: PhoneSessionDependencies): Router {
    const route = `/api/${site.id}/phone-session`;
    const router = Router();
    router.use(json({limit:"16kb"}));
    let running: {id:string | undefined; result:Promise<{cookies:unknown[]}>} | undefined;
    const authorized = (request: Request): boolean => {
        const key = dependencies.key(), given = request.get("X-Phone-Key") ?? "";
        const expected = Buffer.from(key ?? ""), supplied = Buffer.from(given);
        return !!key && supplied.length === expected.length && timingSafeEqual(supplied, expected);
    };
    router.get(route, (request, response) => {
        if (!authorized(request)) return void response.status(401).json({ error: "Not allowed" });
        response.json({ available: dependencies.available() });
    });
    router.post(route, async (request, response) => {
        if (!authorized(request)) return void response.status(401).json({ error: "Not allowed" });
        if(request.body?.setup!==true)return void response.status(400).json({error:"This endpoint is for one-time phone setup; ordinary renewal runs on the phone"});
        if (!dependencies.available()) return void response.status(503).json({ error: `This PC is not set up to log in to ${site.label}` });
        const id = request.get("X-Phone-Request-ID");
        if (id && !/^[a-zA-Z0-9-]{16,80}$/.test(id)) return void response.status(400).json({error:"Invalid request ID"});
        const retained = id ? dependencies.retained?.(id) : null;
        // Retry a lost initial handoff verbatim. The phone refreshes it itself;
        // this setup endpoint never consumes an already-transferred credential.
        if(retained)return void response.json(retained);
        if (running && (!id || running.id!==id)) return void response.status(409).json({ error: `A ${site.label} login is already running` });
        const task = running?.result ?? (async () => {
            const result = await dependencies.login(id);
            if (id) dependencies.retain?.(id,result);
            return result;
        })();
        running ??= {id,result:task};
        try {
            response.json(await task);
        } catch (error) {
            response.status(502).json({ error: error instanceof Error ? error.message : `The ${site.label} login failed` });
        } finally {
            if (running?.result===task) running = undefined;
        }
    });
    router.delete(route, async (request,response) => {
        if (!authorized(request)) return void response.status(401).json({error:"Not allowed"});
        const id=request.get("X-Phone-Request-ID");
        if (id) await dependencies.acknowledge?.(id);
        response.json({acknowledged:true});
    });
    return router;
}
