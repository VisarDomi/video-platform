import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { descriptorConfig } from "./config.js";
import { LlamaServer } from "./llama-server.js";
import { chooseVideoFps, probeDuration, stageMedia } from "./media.js";
import { requestDescription, type DescriptionResult } from "./model-client.js";

export interface ArtifactDescriptionEvidence {
    readonly inputPath: string;
    readonly durationSeconds: number;
    readonly fps: number;
    readonly promptVersion: string;
    readonly elapsedSeconds: number;
    readonly description: DescriptionResult;
    readonly usage: unknown;
    readonly timings: unknown;
    readonly evidencePath: string;
}

export interface DescribeArtifactOptions {
    readonly server?: LlamaServer;
    readonly manageServer?: boolean;
    readonly now?: () => Date;
    readonly evidenceKey?: string;
}

interface StoredEvidence {
    inputPath: string;
    durationSeconds: number;
    fps: number;
    promptVersion: string;
    elapsedSeconds: number;
    description: DescriptionResult;
    usage: unknown;
    timings: unknown;
}

function publicEvidence(evidence: StoredEvidence, evidencePath: string): ArtifactDescriptionEvidence {
    return { ...evidence, evidencePath };
}

export async function describeArtifact(
    inputPath: string,
    options: DescribeArtifactOptions = {},
): Promise<ArtifactDescriptionEvidence> {
    const mediaPath = path.resolve(inputPath);
    const stats = await fs.stat(mediaPath);
    if (!stats.isFile() || path.extname(mediaPath).toLowerCase() === ".m3u8") {
        throw new Error("Descriptor input must be a remuxed media file, not an HLS directory or playlist");
    }

    const durationSeconds = await probeDuration(mediaPath);
    const fps = chooseVideoFps(
        durationSeconds,
        descriptorConfig.videoTokenBudget,
        descriptorConfig.tokensPerFrame,
        descriptorConfig.maximumFps,
    );
    const prompt = await fs.readFile(descriptorConfig.promptPath, "utf8");
    const promptVersion = createHash("sha256").update(prompt).digest("hex");
    const now = options.now ?? (() => new Date());
    if (options.evidenceKey && !/^[a-f0-9]{64}$/.test(options.evidenceKey)) {
        throw new Error("Descriptor evidenceKey must be a lowercase SHA-256");
    }
    const evidenceDirectory = options.evidenceKey
        ? path.join(descriptorConfig.evidenceDirectory, "artifacts", options.evidenceKey, promptVersion)
        : path.join(
            descriptorConfig.evidenceDirectory,
            `${now().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
        );
    const evidencePath = path.join(evidenceDirectory, "result.json");
    if (options.evidenceKey) {
        try {
            const existing = JSON.parse(await fs.readFile(evidencePath, "utf8")) as StoredEvidence;
            if (
                existing.promptVersion === promptVersion
                && existing.fps === fps
                && existing.durationSeconds === durationSeconds
                && typeof existing.description?.title === "string"
            ) {
                return publicEvidence(existing, evidencePath);
            }
        } catch {}
    }

    const staged = await stageMedia(mediaPath, descriptorConfig.mediaDirectory);
    const server = options.server ?? new LlamaServer();
    const manageServer = options.manageServer ?? true;
    const startedAt = Date.now();

    try {
        if (manageServer) await server.start();
        const result = await requestDescription(staged.url, fps, prompt);
        await fs.mkdir(evidenceDirectory, { recursive: true });
        const evidence = {
            inputPath: mediaPath,
            durationSeconds,
            fps,
            promptVersion,
            elapsedSeconds: (Date.now() - startedAt) / 1000,
            description: result.description,
            usage: result.usage,
            timings: result.timings,
            modelResponse: result.raw,
            generatedAt: now().toISOString(),
        };
        const temporaryPath = `${evidencePath}.${randomUUID()}.tmp`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`);
        await fs.rename(temporaryPath, evidencePath);
        return publicEvidence(evidence, evidencePath);
    } finally {
        await staged.remove();
        if (manageServer) await server.stop();
    }
}
