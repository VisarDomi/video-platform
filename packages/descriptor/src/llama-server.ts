import { ChildProcess, spawn } from "node:child_process";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { descriptorConfig } from "./config.js";

const STALE_MEDIA_AGE_MS = 24 * 60 * 60_000;

async function pruneStaleMedia(mediaDirectory: string): Promise<void> {
    const entries = await readdir(mediaDirectory, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - STALE_MEDIA_AGE_MS;
    for (const entry of entries) {
        const fullPath = path.join(mediaDirectory, entry.name);
        if (entry.isSymbolicLink()) {
            // Broken symlinks or symlinks older than 24 h are leftovers from crashed runs.
            const target = await stat(fullPath).catch(() => null);
            if (!target || target.mtimeMs < cutoff) await unlink(fullPath).catch(() => undefined);
        } else if (entry.isFile() && entry.name.endsWith(".upright.mp4")) {
            const info = await stat(fullPath).catch(() => null);
            if (info && info.mtimeMs < cutoff) await unlink(fullPath).catch(() => undefined);
        }
    }
}

async function readIoPressureSomeAvg10(): Promise<number | null> {
    try {
        const text = await readFile("/proc/pressure/io", "utf8");
        const match = text.match(/^some\s+avg10=([\d.]+)/m);
        const value = match ? Number(match[1]) : Number.NaN;
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

// The managed server did not start: it failed to launch, exited, or did not answer its
// health check in time. About the machine (a disk too slow to load the model, a busy GPU),
// not the video being described, so a caller may simply try again later.
export class DescriptorStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DescriptorStartupError";
    }
}

export class LlamaServer {
    private child: ChildProcess | null = null;
    private launchError: Error | null = null;
    private logTail = "";
    private failureLines: string[] = [];
    private stopping = false;

    constructor(
        private readonly config = descriptorConfig,
        private readonly progressIntervalMilliseconds = 30_000,
    ) {
        for (const value of [config.startupTimeoutMilliseconds, config.healthRequestTimeoutMilliseconds]) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Descriptor timeouts must be positive integers");
        }
    }

    // Whether this instance's own server process is up (an external server is never ours).
    get running(): boolean {
        return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
    }

    async start(): Promise<void> {
        if (this.child) throw new Error("llama-server is already managed by this instance");
        this.stopping = false;
        this.launchError = null;
        this.logTail = "";
        this.failureLines = [];
        if (this.config.useExternalServer) {
            await this.waitUntilHealthy();
            return;
        }

        const occupied = await fetch(`${this.config.modelUrl}/health`, {
            signal: AbortSignal.timeout(this.config.healthRequestTimeoutMilliseconds),
        }).then(async response => { await response.body?.cancel(); return true; }).catch(() => false);
        if (this.stopping) throw new Error("Descriptor startup was stopped");
        if (occupied) throw new Error(`Descriptor endpoint ${this.config.modelUrl} is already occupied; refusing to adopt an unmanaged server`);

        await pruneStaleMedia(this.config.mediaDirectory).catch(() => undefined);
        const args = [
            "-m", this.config.modelPath,
            "--mmproj", this.config.projectorPath,
            "--jinja",
            "--chat-template-file", this.config.templatePath,
            "--reasoning", "off",
            "-ngl", "99",
            "-c", String(this.config.contextTokens),
            "--flash-attn", "on",
            "--cache-type-k", "f16",
            "--cache-type-v", "f16",
            "--cache-ram", "0",
            "--image-max-tokens", "70",
            "-np", "1",
            "--host", "127.0.0.1",
            "--port", String(this.config.port),
            "--media-path", `${path.resolve(this.config.mediaDirectory)}${path.sep}`,
            "--no-webui",
        ];
        this.child = spawn(this.config.runtimeExecutable, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        // About a thousand lines per run: kept in memory, and shown only with a
        // failure (startup errors here, request errors through withLog).
        this.child.stdout?.on("data", (chunk: Buffer) => this.recordOutput(chunk));
        this.child.stderr?.on("data", (chunk: Buffer) => this.recordOutput(chunk));
        this.child.once("error", (error) => {
            this.launchError = error;
        });
        try {
            await this.waitUntilHealthy();
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    private recordOutput(chunk: Buffer): void {
        this.logTail = `${this.logTail}${chunk}`.slice(-8192);
        // Native abort handlers print a long backtrace after the useful assertion.
        // Keep that cause even when it scrolls out of the bounded log tail.
        for (const line of chunk.toString().split(/\r?\n/)) {
            if (/GGML_ASSERT|CUDA error|terminate called|what\(\):|assertion.*failed/i.test(line)) {
                const detail = line.trim().slice(0, 1024);
                if (!this.failureLines.includes(detail)) this.failureLines = [...this.failureLines, detail].slice(-4);
            }
        }
    }

    // Only an owned process that actually crashed may be recreated. Ordinary
    // HTTP/model errors, external endpoints and shutdown signals are not retries.
    async requestWithRecovery<T>(request: () => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await request();
            } catch (error) {
                const child = this.child;
                if (child && child.exitCode === null && child.signalCode === null) {
                    await new Promise<void>(resolve => {
                        const done = () => { clearTimeout(timer); child.removeListener("exit", done); resolve(); };
                        const timer = setTimeout(done, 250);
                        child.once("exit", done);
                    });
                }
                const crashed = child && (child.exitCode !== null && child.exitCode !== 0
                    || ["SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE"].includes(child.signalCode ?? ""));
                if (attempt !== 0 || this.stopping || this.config.useExternalServer || this.child !== child || !crashed) {
                    throw this.withLog(error);
                }
                const failure = this.withLog(error);
                const exit = child.signalCode ?? child.exitCode;
                await this.stopChild();
                if (this.stopping) throw failure;
                console.log(JSON.stringify({ event: "descriptor-retry", attempt: 2, reason: "managed_model_crashed", exit,
                    detail: this.failureLines.join("\n") || null }));
                await this.start();
            }
        }
    }

    // The error with the end of the managed server's output, which explains most
    // request failures (out of memory, a crash, a context overflow).
    withLog(error: unknown): Error {
        const message = error instanceof Error ? error.message : String(error);
        const tail = [...this.failureLines, this.logTail.trim().slice(-4096)].filter(Boolean).join("\n");
        return tail ? new Error(`${message}\nllama-server output (end):\n${tail}`, { cause: error }) : error instanceof Error ? error : new Error(message);
    }

    // Stops the managed server when the signal aborts (its host stopping), so a job in flight,
    // or a model still loading (llama-server ignores SIGTERM until its model is loaded), ends
    // within the ten seconds stop() allows rather than running on. Returns the disposer.
    stopWhenAborted(signal: AbortSignal | undefined): () => void {
        if (!signal) return () => undefined;
        const onAbort = () => { void this.stop(); };
        signal.addEventListener("abort", onAbort, { once: true });
        return () => signal.removeEventListener("abort", onAbort);
    }

    async stop(): Promise<void> {
        this.stopping = true;
        await this.stopChild();
    }

    private async stopChild(): Promise<void> {
        const child = this.child;
        this.child = null;
        if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
            child.once("exit", () => { clearTimeout(timer); resolve(); });
            child.kill("SIGTERM");
        });
    }

    private lastOutputLine(): string | null {
        const lines = this.logTail.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        return lines.length ? lines[lines.length - 1].slice(0, 200) : null;
    }

    private async waitUntilHealthy(): Promise<void> {
        const startedAt = Date.now();
        const deadline = startedAt + this.config.startupTimeoutMilliseconds;
        let nextProgress = startedAt + this.progressIntervalMilliseconds;
        while (Date.now() < deadline) {
            if (this.stopping) throw new Error("Descriptor startup was stopped");
            if (this.launchError) throw new DescriptorStartupError(`Failed to launch llama-server: ${this.launchError.message}`);
            if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) {
                throw new DescriptorStartupError(`llama-server exited (${this.child.signalCode ?? this.child.exitCode}): ${this.logTail.trim()}`);
            }
            try {
                const response = await fetch(`${this.config.modelUrl}/health`, {
                    signal: AbortSignal.timeout(Math.max(1, Math.min(this.config.healthRequestTimeoutMilliseconds, deadline - Date.now()))),
                });
                await response.body?.cancel();
                if (response.ok) return;
            } catch {
            }
            if (Date.now() >= nextProgress) {
                console.log(JSON.stringify({
                    event: "descriptor-starting",
                    elapsedSeconds: (Date.now() - startedAt) / 1000,
                    ioPressureSomeAvg10: await readIoPressureSomeAvg10(),
                    lastLogLine: this.lastOutputLine(),
                }));
                nextProgress = Date.now() + this.progressIntervalMilliseconds;
            }
            await delay(Math.max(1, Math.min(500, deadline - Date.now())));
        }
        throw new DescriptorStartupError(`llama-server did not become healthy at ${this.config.modelUrl} within ${this.config.startupTimeoutMilliseconds / 1000}s: ${this.logTail.trim()}`);
    }
}
