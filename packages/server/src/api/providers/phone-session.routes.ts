import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Request } from "express";
import { SHARED_STATE_PATH } from "../../core/config.js";

// The Tango app's shortcut to a login (apps/ios VideoApp/TangoList.swift): the PC signs in with
// a fresh browser profile (packages/auth phoneSession.ts) and hands the phone that new session,
// so every device holds its own refresh token; the PC's own session is never shared. Callers
// need the phone key (`tango-phone-key` in the shared state folder, built into the app);
// one login runs at a time. Tokens are never logged.
export const PHONE_KEY_PATH = path.join(SHARED_STATE_PATH, "tango-phone-key");
const LOGIN_TIMEOUT_MS = 120_000;

export interface PhoneSessionDependencies {
    key(): string | null;
    available(): boolean;
    login(): Promise<{ cookies: unknown[] }>;
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
    return {
        key: () => { try { return phoneKey(); } catch { return null; } },
        available: () => existsSync(path.join(auth, "dist/phoneSession.js")) && existsSync(accounts),
        login: () => new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ["dist/phoneSession.js"], {
                cwd: auth, env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":111", PLAYWRIGHT_BROWSERS_PATH: "0", LOG_LEVEL: "warn" },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "", stderr = "";
            const timer = setTimeout(() => child.kill("SIGTERM"), LOGIN_TIMEOUT_MS);
            child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
            child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
            child.once("error", reject);
            child.once("close", code => {
                clearTimeout(timer);
                const line = stdout.split("\n").find(text => text.startsWith("PHONE-SESSION "));
                if (code === 0 && line) {
                    try { return resolve(JSON.parse(line.slice("PHONE-SESSION ".length)) as { cookies: unknown[] }); } catch { /* reported below */ }
                }
                reject(new Error(stderr.trim().split("\n").slice(-1)[0] || `The Tango login ended (${code ?? "timed out"})`));
            });
        }),
    };
}

export function createPhoneSessionRoutes(dependencies: PhoneSessionDependencies = defaultDependencies()): Router {
    const router = Router();
    let running = false;
    const authorized = (request: Request): boolean => {
        const key = dependencies.key(), given = request.get("X-Phone-Key") ?? "";
        return !!key && given.length === key.length && timingSafeEqual(Buffer.from(given), Buffer.from(key));
    };
    router.get("/api/tango/phone-session", (request, response) => {
        if (!authorized(request)) return void response.status(401).json({ error: "Not allowed" });
        response.json({ available: dependencies.available() });
    });
    router.post("/api/tango/phone-session", async (request, response) => {
        if (!authorized(request)) return void response.status(401).json({ error: "Not allowed" });
        if (!dependencies.available()) return void response.status(503).json({ error: "This PC is not set up to log in to Tango" });
        if (running) return void response.status(409).json({ error: "A Tango login is already running" });
        running = true;
        try {
            response.json(await dependencies.login());
        } catch (error) {
            response.status(502).json({ error: error instanceof Error ? error.message : "The Tango login failed" });
        } finally {
            running = false;
        }
    });
    return router;
}
