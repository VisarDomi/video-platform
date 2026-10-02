import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { StoredCookie } from "../upload/porntrexSession.js";

// The paired iPhone is reached through the Mac (apps/ios/PORT.md): devicectl
// launches the Ptrex app and the existing WebKit inspector runs a script in
// its porntrex page. Same trusted SSH options as apps/ios/scripts/deploy.py.
export interface PtrexPhoneConfig {
    readonly sshTarget: string;
    readonly knownHostsFile: string;
    readonly device: string;
    readonly bundleId: string;
    readonly macAppDirectory: string;
    readonly inspectorPython: string;
}

export const DEFAULT_PTREX_PHONE: PtrexPhoneConfig = {
    sshTarget: process.env.VIDEO_MAC_SSH_TARGET ?? "visar@192.168.1.198",
    knownHostsFile: process.env.VIDEO_MAC_KNOWN_HOSTS ?? "/home/visar/Documents/hackingtosh/validation/macos-known-hosts",
    device: process.env.VIDEO_IPHONE_DEVICE ?? "00008101-000639912881401E",
    bundleId: "com.visar.Ptrex.paid",
    macAppDirectory: "/Users/visar/Developer/video-platform/apps/ios",
    inspectorPython: "/Users/visar/Developer/gallery-reader-extension/inspector-venv/bin/python",
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
        child.once("error", reject);
        child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.stdin.end(input ?? "");
    });
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Runs inside the app's porntrex page. Replaces the phone's PHP session with
// the shared one, removes kt_member (signing back in with it would start a new
// session and log the pipeline out), checks with a fresh same-session request
// and reloads the start page. It returns only booleans and paths.
export function phoneCookieScript(cookies: readonly StoredCookie[], now = new Date()): string {
    const expires = new Date(now.getTime() + 400 * 24 * 60 * 60_000).toUTCString();
    const set = cookies.map((cookie) => {
        const domain = cookie.domain.startsWith(".") ? `; domain=${cookie.domain}` : "";
        const secure = cookie.secure || cookie.sameSite === "None" ? "; Secure" : "";
        return `${cookie.name}=${cookie.value}; path=${cookie.path}${domain}; expires=${expires}; SameSite=${cookie.sameSite}${secure}`;
    });
    const names = [...new Set(["kt_member", ...cookies.map((cookie) => cookie.name)])];
    return `(() => {
    if (!/(^|\\.)porntrex\\.com$/.test(location.hostname)) return JSON.stringify({ loggedIn: false, host: location.hostname, finalPath: "" });
    const past = "Thu, 01 Jan 1970 00:00:00 GMT";
    for (const name of ${JSON.stringify(names)}) {
        document.cookie = name + "=; path=/; expires=" + past;
        document.cookie = name + "=; path=/; domain=.porntrex.com; expires=" + past;
    }
    for (const cookie of ${JSON.stringify(set)}) document.cookie = cookie;
    const request = new XMLHttpRequest();
    request.open("GET", "/upload-video/?connected=" + Date.now(), false);
    request.send();
    const loggedIn = /name="content"/.test(request.responseText);
    if (loggedIn) setTimeout(() => location.replace("/my/videos/"), 50);
    return JSON.stringify({ loggedIn, host: location.hostname, finalPath: new URL(request.responseURL).pathname });
})()`;
}

const VERIFY_SCRIPT = `(() => {
    const request = new XMLHttpRequest();
    request.open("GET", "/upload-video/?verify=" + Date.now(), false);
    request.send();
    return JSON.stringify({ loggedIn: /name="content"/.test(request.responseText), host: location.hostname, finalPath: new URL(request.responseURL).pathname });
})()`;

export class PtrexPhone {
    private readonly ssh: SshRunner;
    constructor(private readonly config: PtrexPhoneConfig = DEFAULT_PTREX_PHONE, ssh?: SshRunner,
        private readonly pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))) {
        this.ssh = ssh ?? sshRunner(config);
    }

    async connect(cookies: readonly StoredCookie[]): Promise<PhoneSessionResult> {
        const file = `/tmp/ptrex-connect-${randomUUID()}.js`;
        const written = await this.ssh(`umask 077 && cat > ${quote(file)}`, phoneCookieScript(cookies));
        if (written.code !== 0) throw new Error(`Could not reach the Mac: ${written.stderr.trim() || "ssh failed"}`);
        try {
            const launch = await this.ssh(`xcrun devicectl device process launch --terminate-existing --device ${quote(this.config.device)} ${quote(this.config.bundleId)}`);
            if (launch.code !== 0) {
                const detail = `${launch.stdout}\n${launch.stderr}`;
                throw new Error(/lock/i.test(detail) ? "The iPhone is locked: unlock it and run the command again"
                    : `Could not open Ptrex on the iPhone: ${detail.trim().split("\n").slice(-2).join(" ")}`);
            }
            const result = await this.evaluate(file);
            if (!result.loggedIn) return result;
            // After the reload the app must still be logged in on the shared session.
            await this.pause(4_000);
            const verifyFile = `/tmp/ptrex-verify-${randomUUID()}.js`;
            await this.ssh(`umask 077 && cat > ${quote(verifyFile)}`, VERIFY_SCRIPT);
            try { return await this.evaluate(verifyFile); } finally { await this.ssh(`rm -f ${quote(verifyFile)}`); }
        } finally {
            await this.ssh(`rm -f ${quote(file)}`);
        }
    }

    private async evaluate(file: string): Promise<PhoneSessionResult> {
        let last = "";
        for (let attempt = 1; attempt <= 8; attempt++) {
            await this.pause(3_000);
            const run = await this.ssh(`cd ${quote(this.config.macAppDirectory)} && ${quote(this.config.inspectorPython)} scripts/app-inspector.py --bundle ${quote(this.config.bundleId)} --evaluate-file ${quote(file)}`);
            const line = run.stdout.split("\n").find((text) => text.startsWith("RESULT "));
            if (line) return JSON.parse(line.slice("RESULT ".length)) as PhoneSessionResult;
            last = `${run.stdout}\n${run.stderr}`.trim().split("\n").filter((text) => !/Warning|warnings\.warn/.test(text)).slice(-1)[0] ?? "";
        }
        throw new Error(`Ptrex's page could not be inspected (keep the iPhone unlocked with Ptrex open): ${last}`);
    }
}
