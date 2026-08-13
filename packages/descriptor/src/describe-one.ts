import path from "node:path";
import { describeArtifact } from "./describe.js";

async function main(): Promise<void> {
    const input = process.argv[2];
    if (!input) throw new Error("Usage: npm run describe-one -w descriptor -- <remuxed-video-file>");

    const result = await describeArtifact(input);
    console.log(`Described ${path.basename(result.inputPath)} at ${result.fps.toFixed(4)} FPS (${result.durationSeconds.toFixed(2)} seconds)`);
    console.log(JSON.stringify(result.description, null, 2));
    console.log(`Description evidence: ${result.evidencePath}`);
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
