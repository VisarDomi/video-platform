import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sharedSessionCookies, type StoredCookie } from "../upload/porntrexSession.js";
import { RecoveryDeferredError } from "../upload/sessionRecoveryState.js";

// The paired iPhone is reached through the Mac (apps/ios/README.md): the shared session is copied
// into Video Vault's own data folder (devicectl), the app takes it into its cookies when it starts
// (VideoApp/VaultList.swift), checks it with a fresh same-session request and leaves the answer
// beside it, which is read back the same way. Same trusted SSH options as apps/ios/scripts/deploy.py.
export interface PtrexPhoneConfig {
    readonly sshTarget: string;
    readonly knownHostsFile: string;
    readonly device: string;
    readonly bundleId: string;
    // In the app's data container.
    readonly folder: string;
}

export const DEFAULT_PTREX_PHONE: PtrexPhoneConfig = {
    sshTarget: process.env.VIDEO_MAC_SSH_TARGET ?? "visar@192.168.1.198",
    knownHostsFile: process.env.VIDEO_MAC_KNOWN_HOSTS ?? "/home/visar/Documents/hackingtosh/validation/macos-known-hosts",
    device: process.env.VIDEO_IPHONE_DEVICE ?? "00008101-000639912881401E",
    bundleId: "com.visar.Ptrex.paid",
    folder: "Library/Application Support/LocalVideos",
};

export interface PhoneSessionResult {
    readonly loggedIn: boolean;
    readonly host: string;
    readonly finalPath: string;
}

export type SshRunner = (command: string, input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

function sshRunner(config: PtrexPhoneConfig): SshRunner {
    return (command, input) => new Promise((resolve, reject) => {
        const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes",
            "-o", `UserKnownHostsFile=${config.knownHostsFile}`, config.sshTarget, command], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
        const timeout = setTimeout(() => child.kill("SIGTERM"), command.includes("phone-pairing") ? 120_000 : 60_000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("close", (code) => { clearTimeout(timeout); resolve({ code: code ?? 1, stdout, stderr }); });
        child.stdin.end(input ?? "");
    });
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const APPLE_TOOL = "/Users/visar/Developer/ios-tools/native/scripts/apple-tool devicectl";

// What the app takes in: the shared session's cookies (it removes kt_member, whose sign-in would
// start a new session and log the pipeline out), named by an ID its answer repeats.
export function phoneSessionInbox(cookies: readonly StoredCookie[], id: string): string {
    return JSON.stringify({
        id,
        cookies: cookies.filter((cookie) => cookie.name !== "kt_member").map((cookie) => ({
            name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
        })),
    });
}

export class PtrexPhone {
    private readonly ssh: SshRunner;
    constructor(private readonly config: PtrexPhoneConfig = DEFAULT_PTREX_PHONE, ssh?: SshRunner,
        private readonly pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))) {
        this.ssh = ssh ?? sshRunner(config);
    }

    async readSession(): Promise<StoredCookie[]> {
        const id = randomUUID(), file = `/tmp/ptrex-cookies-${id}.json`;
        const device = quote(this.config.device), bundle = quote(this.config.bundleId);
        try {
            const command = `umask 077; ${APPLE_TOOL} device copy from --device ${device} --domain-type appDataContainer --domain-identifier ${bundle} --source ${quote(`${this.config.folder}/cookies.json`)} --destination ${quote(file)} --timeout 30 --quiet && /usr/bin/python3 -c ${quote("import json; print(json.dumps([c for c in json.load(open(" + JSON.stringify(file) + ")) if c['name'] in ('PHPSESSID','confirmed') and c['domain'].lstrip('.') in ('porntrex.com','www.porntrex.com')]))")}`;
            const run = await this.deviceRequest(command);
            if (run.code !== 0) throw new RecoveryDeferredError("Could not inspect the local phone session; recovery will retry");
            let cookies: Array<{ name: string; value: string; domain: string; path: string; expires?: number; secure: boolean; httpOnly: boolean }>;
            try { cookies = JSON.parse(run.stdout); if (!Array.isArray(cookies)) throw new Error(); }
            catch { throw new Error("Phone session data could not be read; recovery will retry"); }
            return sharedSessionCookies(cookies.map(cookie => ({ ...cookie, sameSite: "Lax" as const,
                expires: cookie.expires === undefined ? -1 : cookie.expires + 978307200 })));
        } finally { await this.ssh(`rm -f ${quote(file)}`); }
    }

    private async deviceRequest(command: string) {
        let result = await this.ssh(command);
        if (result.code !== 0 && /unreachable|unable to locate|connection|disconnected|timed out|device.*not found/i.test(`${result.stdout}\n${result.stderr}`)) {
            // A monitor/preflight can be busy while a real device request works.
            // Try the operation first; repair and retry only an actual transport failure.
            await this.ssh("/Users/visar/Developer/ios-tools/native/scripts/phone-pairing --repair");
            result = await this.ssh(command);
        }
        return result;
    }

    async connect(cookies: readonly StoredCookie[]): Promise<PhoneSessionResult> {
        const id = randomUUID();
        const inbox = `/tmp/ptrex-session-${id}.json`;
        const answer = `/tmp/ptrex-result-${id}.json`;
        const device = quote(this.config.device), bundle = quote(this.config.bundleId);
        const container = `--domain-type appDataContainer --domain-identifier ${bundle}`;
        const written = await this.ssh(`umask 077 && cat > ${quote(inbox)}`, phoneSessionInbox(cookies, id));
        if (written.code !== 0) throw new Error(`Could not reach the Mac: ${written.stderr.trim() || "ssh failed"}`);
        try {
            const copy = `${APPLE_TOOL} device copy to --device ${device} ${container} --source ${quote(inbox)} --destination ${quote(`${this.config.folder}/porntrex-session.json`)} --timeout 30`;
            const copied = await this.deviceRequest(copy);
            if (copied.code !== 0) throw this.failure(copied, "Could not copy the session into Video Vault");
            // A fresh start takes the session in.
            const launch = await this.deviceRequest(`${APPLE_TOOL} device process launch --terminate-existing --device ${device} ${bundle} --timeout 30`);
            if (launch.code !== 0) throw this.failure(launch, "Could not open Video Vault on the iPhone");
            let last = "";
            for (let attempt = 1; attempt <= 10; attempt++) {
                await this.pause(3_000);
                const read = await this.ssh(`rm -f ${quote(answer)}; ${APPLE_TOOL} device copy from --device ${device} ${container} --source ${quote(`${this.config.folder}/porntrex-session-result.json`)} --destination ${quote(answer)} --timeout 30 >/dev/null 2>&1 && cat ${quote(answer)}`);
                try {
                    const result = JSON.parse(read.stdout) as { id?: string; loggedIn?: boolean; finalPath?: string };
                    if (result.id === id) return { loggedIn: result.loggedIn === true, host: "www.porntrex.com", finalPath: result.finalPath ?? "" };
                    last = "an earlier answer";
                } catch { last = read.stderr.trim().split("\n").slice(-1)[0] ?? ""; }
            }
            throw new Error(`Video Vault did not answer (keep the iPhone unlocked): ${last || "no answer"}`);
        } finally {
            await this.ssh(`rm -f ${quote(inbox)} ${quote(answer)}`);
        }
    }

    private failure(run: { stdout: string; stderr: string }, what: string): Error {
        const detail = `${run.stdout}\n${run.stderr}`;
        return new Error(/lock/i.test(detail) ? "The iPhone is locked: unlock it and run the command again"
            : `${what}: ${detail.trim().split("\n").slice(-2).join(" ")}`);
    }
}
