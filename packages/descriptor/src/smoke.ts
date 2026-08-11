import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { descriptorConfig } from "./config.js";
import { LlamaServer } from "./llama-server.js";
import { chooseVideoFps, probeDuration, stageMedia } from "./media.js";
import { requestDescription } from "./model-client.js";

async function main(): Promise<void> {
    const input = process.argv[2];
    if (!input) throw new Error("Usage: npm run smoke -w descriptor -- <remuxed-video-file>");

    const mediaPath = path.resolve(input);
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
    const staged = await stageMedia(mediaPath, descriptorConfig.mediaDirectory);
    const server = new LlamaServer();

    console.log(`Describing ${path.basename(mediaPath)} at ${fps.toFixed(4)} FPS (${durationSeconds.toFixed(2)} seconds)`);
    const startedAt = Date.now();
    try {
        await server.start();
        const result = await requestDescription(staged.url, fps, prompt);
        const evidenceDirectory = path.join(
            descriptorConfig.evidenceDirectory,
            `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
        );
        await fs.mkdir(evidenceDirectory, { recursive: true });
        const output = {
            inputPath: mediaPath,
            durationSeconds,
            fps,
            elapsedSeconds: (Date.now() - startedAt) / 1000,
            description: result.description,
            usage: result.usage,
            timings: result.timings,
            modelResponse: result.raw,
            generatedAt: new Date().toISOString(),
        };
        const outputPath = path.join(evidenceDirectory, "result.json");
        await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
        console.log(JSON.stringify(result.description, null, 2));
        console.log(`Smoke-test evidence: ${outputPath}`);
    } finally {
        await staged.remove();
        await server.stop();
    }
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
