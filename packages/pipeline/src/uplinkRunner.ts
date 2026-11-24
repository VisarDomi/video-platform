// The uplink runner: performs one upload (or answers a probe) on the uplink's machine when
// the PC tells it to, over stdin/stdout (see uplink/protocol.ts). It holds no state that
// matters: the ledger, the reservation, the attempt and every decision stay on the PC. It
// imports only the SDK and the destination's plug-in.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
    loadDestinationPlugin, TransferAbortedBeforeSubmissionError, uploadErrorToWire,
    type DestinationEntry, type DestinationHost, type SharedSessionSnapshot, type UploadRequest,
} from "sdk";
import { networkIdentity } from "./uplink/networkIdentity.js";
import {
    CARRIER_FILES, CARRIER_MARKER, NETWORK_RECHECK_MS, parseMessage, PING_TIMEOUT_MS, readLines, UPLINK_PROTOCOL,
    type CarrierLocation, type NetworkExpectation,
} from "./uplink/protocol.js";

const run = promisify(execFile);

// The commit this runner was deployed from: runner.json at the deployed tree's root (the
// deploy script writes it), or the file VIDEO_UPLINK_RUNNER_INFO names.
async function runnerCommit(): Promise<string | null> {
    const file = process.env.VIDEO_UPLINK_RUNNER_INFO
        ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runner.json");
    try {
        const info = JSON.parse(await readFile(file, "utf8")) as { commit?: unknown };
        return typeof info.commit === "string" ? info.commit : null;
    } catch { return null; }
}

async function sha256(file: string, signal: AbortSignal): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

async function carrierMatches(carrier: CarrierLocation): Promise<boolean> {
    try {
        const marker = JSON.parse(await readFile(path.join(carrier.root, CARRIER_MARKER), "utf8")) as { carrier?: unknown };
        return marker.carrier === carrier.id;
    } catch { return false; }
}

async function browserVersion(): Promise<string | null> {
    const executable = process.env.VIDEO_CHROMIUM_PATH;
    if (!executable) return null;
    try { return (await run(executable, ["--version"], { timeout: 20_000 })).stdout.trim() || null; } catch { return null; }
}

// A file name the PC may ask for: one plain name inside the carrier's files folder.
function safeName(name: unknown): string {
    if (typeof name !== "string" || !name || name !== path.basename(name) || name.startsWith(".") || name.includes("\0")) {
        throw new Error("uplink: the requested carrier file name is not a plain file name");
    }
    return name;
}

// The runner's private folder (the session file, the browser profile) lives only as long
// as its upload; one left by a runner that was killed is deleted by the next upload.
const SCRATCH_PREFIX = "video-uplink-";
const STALE_SCRATCH_MS = 6 * 60 * 60_000;
async function removeStaleScratch(): Promise<void> {
    const names = await readdir(os.tmpdir()).catch(() => [] as string[]);
    for (const name of names.filter((entry) => entry.startsWith(SCRATCH_PREFIX))) {
        const folder = path.join(os.tmpdir(), name);
        const info = await stat(folder).catch(() => null);
        if (info?.isDirectory() && Date.now() - info.mtimeMs > STALE_SCRATCH_MS) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
}

class Runner {
    private readonly controller = new AbortController();
    private readonly pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
    private sequence = 0;
    private lastPing = Date.now();
    private command: ((message: Record<string, unknown> & { type: string }) => void) | null = null;
    private stopReason = "";

    constructor() {
        readLines(process.stdin, (line) => this.receive(line), () => this.stop("the PC closed the connection"));
        setInterval(() => {
            if (Date.now() - this.lastPing > PING_TIMEOUT_MS) this.stop("no ping from the PC for a minute");
        }, 5_000).unref();
    }

    get signal(): AbortSignal { return this.controller.signal; }

    stop(reason: string): void {
        if (this.controller.signal.aborted) return;
        this.stopReason = reason;
        this.controller.abort(new Error(reason));
        for (const waiting of this.pending.values()) waiting.reject(new TransferAbortedBeforeSubmissionError(`uplink runner stopped: ${reason}`));
        this.pending.clear();
    }

    get stopped(): string | null { return this.controller.signal.aborted ? this.stopReason : null; }

    private receive(line: string): void {
        let message;
        try { message = parseMessage(line); } catch { return this.stop("the PC sent a line that is not protocol"); }
        this.lastPing = Date.now();
        if (message.type === "ping") return;
        if (message.type === "ack" || message.type === "nack") {
            const waiting = this.pending.get(Number(message.seq));
            if (!waiting) return;
            this.pending.delete(Number(message.seq));
            if (message.type === "ack") waiting.resolve();
            else waiting.reject(new TransferAbortedBeforeSubmissionError(`the PC refused a report: ${String(message.message ?? "")}`));
            return;
        }
        const handler = this.command;
        this.command = null;
        if (!handler) return this.stop(`unexpected ${message.type} line`);
        handler(message);
    }

    nextCommand(): Promise<Record<string, unknown> & { type: string }> {
        return new Promise((resolve, reject) => {
            this.command = resolve;
            this.controller.signal.addEventListener("abort", () => reject(this.controller.signal.reason), { once: true });
        });
    }

    send(message: Record<string, unknown>): Promise<void> {
        return new Promise((resolve) => process.stdout.write(`${JSON.stringify(message)}\n`, () => resolve()));
    }

    // A report the PC records durably before it answers: the upload goes on only then.
    async report(message: Record<string, unknown>): Promise<void> {
        if (this.controller.signal.aborted) throw new TransferAbortedBeforeSubmissionError(`uplink runner stopped: ${this.stopReason}`);
        const seq = ++this.sequence;
        const answered = new Promise<void>((resolve, reject) => this.pending.set(seq, { resolve, reject }));
        await this.send({ ...message, seq });
        await answered;
    }
}

async function probe(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const network = message.network as NetworkExpectation;
    const carrier = message.carrier as CarrierLocation;
    const identity = await networkIdentity(network.probe).catch((error: Error) => `unknown: ${error.message}`);
    const present = await stat(carrier.root).then((info) => info.isDirectory(), () => false);
    const matches = present && await carrierMatches(carrier);
    let files: Array<{ name: string; sizeBytes: number }> = [];
    let freeBytes: number | null = null;
    if (matches) {
        const names = await readdir(path.join(carrier.root, CARRIER_FILES)).catch(() => [] as string[]);
        for (const name of names) {
            if (name.startsWith(".") || name.endsWith(".partial")) continue;
            const info = await stat(path.join(carrier.root, CARRIER_FILES, name)).catch(() => null);
            if (info?.isFile()) files.push({ name, sizeBytes: info.size });
        }
        files = files.sort((a, b) => a.name.localeCompare(b.name));
        const space = await statfs(carrier.root).catch(() => null);
        freeBytes = space ? space.bavail * space.bsize : null;
    }
    return {
        type: "probe", identity, onUplink: identity === network.gateway,
        carrier: { present, matches, files, freeBytes },
        browser: await browserVersion(), platform: process.platform, commit: await runnerCommit(),
    };
}

async function release(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const carrier = message.carrier as CarrierLocation;
    // Only a mounted volume is unmounted (a plain directory carrier has nothing to release).
    if (process.platform !== "darwin" || !carrier.root.startsWith("/Volumes/")) return { type: "released", unmounted: false };
    const present = await stat(carrier.root).then(() => true, () => false);
    if (!present) return { type: "released", unmounted: false, note: "not mounted" };
    if (!await carrierMatches(carrier)) return { type: "released", unmounted: false, note: "another drive is mounted there" };
    await run("/usr/sbin/diskutil", ["unmount", carrier.root], { timeout: 60_000 });
    return { type: "released", unmounted: true };
}

async function upload(runner: Runner, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const network = message.network as NetworkExpectation;
    const carrier = message.carrier as CarrierLocation;
    const file = message.file as { name: unknown; sha256: unknown };
    const entry = message.destination as DestinationEntry;
    const session = message.session as SharedSessionSnapshot;
    const request = message.request as Omit<UploadRequest, "onProgress" | "onEvidence">;
    const expected = network.gateway;
    const here = await networkIdentity(network.probe);
    if (here !== expected) {
        throw new TransferAbortedBeforeSubmissionError(`uplink: this machine is on network ${here}, not the uplink's; nothing was sent`);
    }
    if (!await carrierMatches(carrier)) {
        throw new TransferAbortedBeforeSubmissionError(`uplink: carrier ${carrier.id} is not at ${carrier.root}; nothing was sent`);
    }
    const name = safeName(file.name);
    const artifactPath = path.join(carrier.root, CARRIER_FILES, name);
    const info = await stat(artifactPath).catch(() => null);
    if (!info?.isFile() || info.size !== request.sizeBytes) {
        throw new TransferAbortedBeforeSubmissionError(`uplink: carrier file ${name} is missing or not ${request.sizeBytes} bytes; nothing was sent`);
    }
    if (await sha256(artifactPath, runner.signal) !== file.sha256) {
        throw new TransferAbortedBeforeSubmissionError(`uplink: carrier file ${name} does not match its ledger hash; nothing was sent`);
    }
    const executablePath = process.env.VIDEO_CHROMIUM_PATH;
    if (!executablePath) throw new Error("uplink: VIDEO_CHROMIUM_PATH names no browser for the runner");
    const plugin = await loadDestinationPlugin(entry);
    if (!plugin.createCompanionDestination) throw new Error(`uplink: destination ${entry.id} cannot upload on a shared session`);

    await removeStaleScratch();
    const scratch = await mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX));
    // The network is checked again while the transfer runs; a different one stops it. Once
    // the metadata step is reported the copy may exist: from then on nothing stops the
    // upload, and its outcome (or error) goes to the PC as it is.
    let submitting = false;
    const watch = setInterval(() => {
        void networkIdentity(network.probe).then((identity) => {
            if (identity !== expected && !submitting) runner.stop(`the network changed to ${identity}`);
        }, () => undefined);
    }, NETWORK_RECHECK_MS);
    try {
        const host: DestinationHost = {
            config: entry.config ?? {},
            stateDir: path.join(scratch, "state"),
            browser: { executablePath, profilePath: path.join(scratch, "profile"), headless: true },
            credentials: () => { throw new Error("the uplink runner never signs in"); },
            stopSignal: runner.signal,
        };
        await mkdir(host.stateDir, { recursive: true, mode: 0o700 });
        await mkdir(host.browser.profilePath, { recursive: true, mode: 0o700 });
        const destination = plugin.createCompanionDestination(host, session,
            async (replaced) => { await runner.report({ type: "session", session: replaced }); });
        const outcome = await destination.upload({
            ...request,
            artifactPath,
            onProgress: async (phase, transmittedBytes) => {
                // The step that creates the remote copy follows: only on the uplink's network.
                if (phase === "metadata_submitting") {
                    const identity = await networkIdentity(network.probe);
                    if (identity !== expected) {
                        runner.stop(`the network changed to ${identity}`);
                        throw new TransferAbortedBeforeSubmissionError(`uplink: the network changed to ${identity} before the metadata step; nothing was created`);
                    }
                    submitting = true;
                }
                await runner.report({ type: "progress", phase, bytes: transmittedBytes });
            },
            onEvidence: async (evidence) => { await runner.report({ type: "evidence", evidence }); },
        });
        return { type: "result", outcome };
    } finally {
        clearInterval(watch);
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function main(): Promise<void> {
    const runner = new Runner();
    await runner.send({ type: "hello", protocol: UPLINK_PROTOCOL, commit: await runnerCommit(), platform: process.platform });
    let reply: Record<string, unknown>;
    try {
        const message = await runner.nextCommand();
        if (message.type === "probe") reply = await probe(message);
        else if (message.type === "release") reply = await release(message);
        else if (message.type === "upload") reply = await upload(runner, message);
        else throw new Error(`uplink: unknown command ${message.type}`);
    } catch (error) {
        // As it is: the PC decides from its own record whether the metadata step was reached.
        const stopped = runner.stopped;
        reply = { type: "error", error: uploadErrorToWire(error), ...(stopped ? { stopped } : {}) };
    }
    await runner.send(reply);
    process.exit(0);
}

void main().catch((error: unknown) => {
    process.stderr.write(`uplink runner: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
