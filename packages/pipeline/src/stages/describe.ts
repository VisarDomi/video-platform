import { readFile } from "node:fs/promises";
import { describeArtifact } from "descriptor";
import type { ArtifactRecord } from "../domain/types.js";
import { StageDeferredError, type DescriptionEvidence } from "../scheduler/orchestrator.js";
import { isCounterclockwiseArtifact } from "./artifactNaming.js";

// The descriptor's llama-server holds about 11 GB of RAM while describing; on a
// machine short of memory the kernel kills it and the stage would fail.
const DESCRIBE_MIN_AVAILABLE_GIB = Number(process.env.VIDEO_PIPELINE_DESCRIBE_MIN_MEMORY_GIB ?? 16);

async function availableMemoryBytes(): Promise<number | null> {
    const kilobytes = (await readFile("/proc/meminfo", "utf8").catch(() => "")).match(/^MemAvailable:\s+(\d+) kB/m)?.[1];
    return kilobytes ? Number(kilobytes) * 1024 : null;
}

export async function describeValidatedArtifact(
    artifact: ArtifactRecord,
    avoidPhrases: readonly string[] = [],
): Promise<DescriptionEvidence> {
    // A portrait picture was turned counterclockwise for upload; the model
    // reads it lying on its side, so it is shown the picture turned back.
    const result = await describeArtifact(artifact.path, {
        evidenceKey: artifact.sha256,
        avoidPhrases,
        // Only a description that is not cached starts the model server.
        beforeWork: async () => {
            const available = await availableMemoryBytes();
            if (available !== null && available < DESCRIBE_MIN_AVAILABLE_GIB * 2 ** 30) {
                // A stable message: the campaign logs a waiting step only when it changes.
                throw new StageDeferredError(`waiting for ${DESCRIBE_MIN_AVAILABLE_GIB} GiB of available memory before starting the descriptor`);
            }
        },
        ...(isCounterclockwiseArtifact(artifact.path) ? { rotation: "clockwise" as const } : {}),
    });
    return {
        artifactSha256: artifact.sha256,
        promptVersion: result.promptVersion,
        fps: result.fps,
        output: result.description,
        evidencePath: result.evidencePath,
    };
}
