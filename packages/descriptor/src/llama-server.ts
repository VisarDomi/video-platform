import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { descriptorConfig } from "./config.js";

export class LlamaServer {
    private child: ChildProcess | null = null;
    private launchError: Error | null = null;
    private logTail = "";

    constructor(private readonly config = descriptorConfig) {
        for (const value of [config.startupTimeoutMilliseconds, config.healthRequestTimeoutMilliseconds]) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Descriptor timeouts must be positive integers");
        }
    }

    async start(): Promise<void> {
        if (this.child) throw new Error("llama-server is already managed by this instance");
        this.launchError = null;
        this.logTail = "";
        if (this.config.useExternalServer) {
            await this.waitUntilHealthy();
            return;
        }

        const occupied = await fetch(`${this.config.modelUrl}/health`, {
            signal: AbortSignal.timeout(this.config.healthRequestTimeoutMilliseconds),
        }).then(async response => { await response.body?.cancel(); return true; }).catch(() => false);
        if (occupied) throw new Error(`Descriptor endpoint ${this.config.modelUrl} is already occupied; refusing to adopt an unmanaged server`);

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
        this.child.stdout?.on("data", (chunk: Buffer) => { this.logTail = `${this.logTail}${chunk}`.slice(-8192); process.stdout.write(chunk); });
        this.child.stderr?.on("data", (chunk: Buffer) => { this.logTail = `${this.logTail}${chunk}`.slice(-8192); process.stderr.write(chunk); });
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

    async stop(): Promise<void> {
        const child = this.child;
        this.child = null;
        if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
            child.once("exit", () => { clearTimeout(timer); resolve(); });
            child.kill("SIGTERM");
        });
    }

    private async waitUntilHealthy(): Promise<void> {
        const startedAt = Date.now();
        const deadline = startedAt + this.config.startupTimeoutMilliseconds;
        let nextProgress = startedAt + 30_000;
        while (Date.now() < deadline) {
            if (this.launchError) throw new Error(`Failed to launch llama-server: ${this.launchError.message}`);
            if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) {
                throw new Error(`llama-server exited (${this.child.signalCode ?? this.child.exitCode}): ${this.logTail.trim()}`);
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
                console.log(JSON.stringify({ event: "descriptor-starting", elapsedSeconds: (Date.now() - startedAt) / 1000 }));
                nextProgress = Date.now() + 30_000;
            }
            await delay(Math.max(1, Math.min(500, deadline - Date.now())));
        }
        throw new Error(`llama-server did not become healthy at ${this.config.modelUrl} within ${this.config.startupTimeoutMilliseconds / 1000}s: ${this.logTail.trim()}`);
    }
}
