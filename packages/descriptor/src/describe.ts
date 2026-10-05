import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { descriptorConfig } from "./config.js";
import { LlamaServer } from "./llama-server.js";
import { chooseVideoFps, makeUprightCopy, probeDuration, stageMedia } from "./media.js";
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
    readonly rotation: DescriptionRotation | null;
}

// "clockwise": the picture was turned 90° counterclockwise for upload; the
// model is shown it turned back. Part of the evidence identity.
export type DescriptionRotation = "clockwise";

export interface DescribeArtifactOptions {
    readonly rotation?: DescriptionRotation;
    readonly server?: LlamaServer;
    // Phrases an upload provider rejected in earlier metadata. Appended to the
    // prompt so new descriptions avoid them; part of the prompt version.
    readonly avoidPhrases?: readonly string[];
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
    // Absent in evidence written before rotation existed: none.
    rotation?: DescriptionRotation | null;
}

// The exact prompt the model receives. Providers match blocked words as
// substrings, so the instruction covers words that merely contain a phrase.
export function descriptionPrompt(basePrompt: string, avoidPhrases: readonly string[] = []): string {
    const phrases = [...new Set(avoidPhrases.map((phrase) => phrase.trim().toLowerCase()).filter(Boolean))].sort();
    if (!phrases.length) return basePrompt;
    return `${basePrompt.trimEnd()}\n\nNever write any of these phrases anywhere in the title or description, not even inside a longer word: ${
        phrases.map((phrase) => JSON.stringify(phrase)).join(", ")}. Choose different wording instead.\n`;
}

export async function descriptionPromptVersion(avoidPhrases: readonly string[] = []): Promise<string> {
    const prompt = descriptionPrompt(await fs.readFile(descriptorConfig.promptPath, "utf8"), avoidPhrases);
    return createHash("sha256").update(prompt).digest("hex");
}

function publicEvidence(evidence: StoredEvidence, evidencePath: string): ArtifactDescriptionEvidence {
    return { ...evidence, rotation: evidence.rotation ?? null, evidencePath };
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
    const prompt = descriptionPrompt(await fs.readFile(descriptorConfig.promptPath, "utf8"), options.avoidPhrases);
    const promptVersion = createHash("sha256").update(prompt).digest("hex");
    const now = options.now ?? (() => new Date());
    const rotation = options.rotation ?? null;
    if (rotation !== null && rotation !== "clockwise") throw new Error(`Unsupported description rotation ${rotation}`);
    if (options.evidenceKey && !/^[a-f0-9]{64}$/.test(options.evidenceKey)) {
        throw new Error("Descriptor evidenceKey must be a lowercase SHA-256");
    }
    const evidenceDirectory = options.evidenceKey
        ? path.join(descriptorConfig.evidenceDirectory, "artifacts", options.evidenceKey,
            rotation ? `${promptVersion}-${rotation}` : promptVersion)
        : path.join(
            descriptorConfig.evidenceDirectory, "manual",
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
                && (existing.rotation ?? null) === rotation
                && typeof existing.description?.title === "string"
            ) {
                return publicEvidence(existing, evidencePath);
            }
        } catch {}
    }

    const startedAt = Date.now();
    const upright = rotation === "clockwise"
        ? await makeUprightCopy(mediaPath, descriptorConfig.mediaDirectory, descriptorConfig.maximumFps) : null;
    let staged: Awaited<ReturnType<typeof stageMedia>> | null = null;
    const server = options.server ?? new LlamaServer();
    const manageServer = options.manageServer ?? true;

    try {
        staged = await stageMedia(upright?.path ?? mediaPath, descriptorConfig.mediaDirectory);
        if (manageServer) await server.start();
        const result = await requestDescription(staged.url, fps, prompt);
        await fs.mkdir(evidenceDirectory, { recursive: true });
        const evidence = {
            inputPath: mediaPath,
            durationSeconds,
            fps,
            promptVersion,
            rotation,
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
        await staged?.remove();
        await upright?.remove();
        if (manageServer) await server.stop();
    }
}
