import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Router, json, type Request } from "express";
import { SHARED_STATE_PATH } from "../../core/config.js";

// The Tango app's shortcut to a login (apps/ios VideoApp/TangoList.swift): the PC signs in with
// a fresh browser profile (packages/auth phoneSession.ts) and hands the phone that new session,
// so every device holds its own refresh token; the PC's own session is never shared. Callers
// need the phone key (`tango-phone-key` in the shared state folder, built into the app);
// one login runs at a time. Tokens are never logged.
export const PHONE_KEY_PATH = path.join(SHARED_STATE_PATH, "tango-phone-key");

export interface PhoneSessionDependencies {
    key(): string | null;
    available(): boolean;
    login(requestId?:string): Promise<{ cookies: unknown[] }>;
    retained?(requestId: string): {cookies: unknown[]} | null;
    retain?(requestId: string, result: {cookies: unknown[]}): void;
    acknowledge?(requestId: string): void | Promise<void>;
}

export function phoneKey(file = PHONE_KEY_PATH): string {
    if (!existsSync(file)) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    }
    return readFileSync(file, "utf-8").trim();
}

function defaultDependencies(): PhoneSessionDependencies {
    const auth = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../auth");
    const accounts = process.env.VIDEO_AUTH_ACCOUNTS_FILE ?? path.join(os.homedir(), ".config/video-services/auth-accounts.json");
    const receipt = path.join(SHARED_STATE_PATH, "tango-phone-handoff.json");
    const held = () => { try { return JSON.parse(readFileSync(receipt, "utf8")) as {id:string;time:number;result:{cookies:unknown[]}}; } catch (error: any) { if(error.code==="ENOENT") return null; throw error; } };
    return {
        key: () => { try { return phoneKey(); } catch { return null; } },
        available: () => existsSync(path.join(auth, "dist/phoneBrowserSession.js")) && existsSync(accounts),
        retained: id => { const value=held(); return value?.id===id ? value.result : null; },
        retain: (id,result) => {
            writeFileSync(receipt+".tmp", JSON.stringify({id,time:Date.now(),result}), {mode:0o600});
            renameSync(receipt+".tmp",receipt);
        },
        acknowledge: async id => {
            const module=await import(pathToFileURL(path.join(auth,"dist/phoneBrowserSession.js")).href);
            await module.acknowledgePhoneSetup(id);
            if(held()?.id===id)unlinkSync(receipt);
        },
        login: async requestId => {
            // One persistent owner lives with this existing server. Do not create
            // a fresh Google/browser session for each native renewal request.
            process.env.DISPLAY ??= ":111";
            process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
            const module = await import(pathToFileURL(path.join(auth,"dist/phoneBrowserSession.js")).href);
            return module.phoneBrowserSession(requestId??randomBytes(16).toString("hex"));
        },
    };
}

export function createPhoneSessionRoutes(dependencies: PhoneSessionDependencies = defaultDependencies()): Router {
    const router = Router();
    router.use(json({limit:"16kb"}));
    let running: {id:string | undefined; result:Promise<{cookies:unknown[]}>} | undefined;
    const authorized = (request: Request): boolean => {
        const key = dependencies.key(), given = request.get("X-Phone-Key") ?? "";
        const expected = Buffer.from(key ?? ""), supplied = Buffer.from(given);
        return !!key && supplied.length === expected.length && timingSafeEqual(supplied, expected);
    };
    router.get("/api/tango/phone-session", (request, response) => {
        if (!authorized(request)) return void response.status(401).json({ error: "Not allowed" });
        response.json({ available: dependencies.available() });
    });
    router.post("/api/tango/phone-session", async (request, response) => {
        if (!authorized(request)) return void response.status(401).json({ error: "Not allowed" });
        if(request.body?.setup!==true)return void response.status(400).json({error:"This endpoint is for one-time phone setup; ordinary renewal runs on the phone"});
        if (!dependencies.available()) return void response.status(503).json({ error: "This PC is not set up to log in to Tango" });
        const id = request.get("X-Phone-Request-ID");
        if (id && !/^[a-zA-Z0-9-]{16,80}$/.test(id)) return void response.status(400).json({error:"Invalid request ID"});
        const retained = id ? dependencies.retained?.(id) : null;
        // Retry a lost initial handoff verbatim. The phone refreshes it itself;
        // this setup endpoint never consumes an already-transferred credential.
        if(retained)return void response.json(retained);
        if (running && (!id || running.id!==id)) return void response.status(409).json({ error: "A Tango login is already running" });
        const task = running?.result ?? (async () => {
            const result = await dependencies.login(id);
            if (id) dependencies.retain?.(id,result);
            return result;
        })();
        running ??= {id,result:task};
        try {
            response.json(await task);
        } catch (error) {
            response.status(502).json({ error: error instanceof Error ? error.message : "The Tango login failed" });
        } finally {
            if (running?.result===task) running = undefined;
        }
    });
    router.delete("/api/tango/phone-session", async (request,response) => {
        if (!authorized(request)) return void response.status(401).json({error:"Not allowed"});
        const id=request.get("X-Phone-Request-ID");
        if (id) await dependencies.acknowledge?.(id);
        response.json({acknowledged:true});
    });
    return router;
}
