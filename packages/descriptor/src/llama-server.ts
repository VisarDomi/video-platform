import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { descriptorConfig } from "./config.js";

export class LlamaServer {
    private child: ChildProcess | null = null;

    async start(): Promise<void> {
        if (descriptorConfig.useExternalServer) {
            await this.waitUntilHealthy();
            return;
        }

        const args = [
            "-m", descriptorConfig.modelPath,
            "--mmproj", descriptorConfig.projectorPath,
            "--jinja",
            "--chat-template-file", descriptorConfig.templatePath,
            "--reasoning", "off",
            "-ngl", "99",
            "-c", String(descriptorConfig.contextTokens),
            "--flash-attn", "on",
            "--cache-type-k", "f16",
            "--cache-type-v", "f16",
            "--image-max-tokens", "70",
            "-np", "1",
            "--host", "127.0.0.1",
            "--port", String(descriptorConfig.port),
            "--media-path", `${path.resolve(descriptorConfig.mediaDirectory)}${path.sep}`,
            "--no-webui",
        ];
        this.child = spawn(descriptorConfig.runtimeExecutable, args, {
            stdio: ["ignore", "inherit", "inherit"],
        });
        this.child.once("error", (error) => {
            console.error(`Failed to launch llama-server: ${error.message}`);
        });
        await this.waitUntilHealthy();
    }

    async stop(): Promise<void> {
        const child = this.child;
        this.child = null;
        if (!child || child.exitCode !== null) return;
        child.kill("SIGTERM");
        await Promise.race([
            new Promise<void>((resolve) => child.once("exit", () => resolve())),
            delay(10_000).then(() => { child.kill("SIGKILL"); }),
        ]);
    }

    private async waitUntilHealthy(): Promise<void> {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
                throw new Error(`llama-server exited with code ${this.child.exitCode}`);
            }
            try {
                const response = await fetch(`${descriptorConfig.modelUrl}/health`);
                if (response.ok) return;
            } catch {
            }
            await delay(500);
        }
        throw new Error(`llama-server did not become healthy at ${descriptorConfig.modelUrl}`);
    }
}
