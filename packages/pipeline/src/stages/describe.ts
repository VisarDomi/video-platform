import { readdir, readFile } from "node:fs/promises";
import { describeArtifact, DescriptorStartupError } from "descriptor";
import type { ArtifactRecord } from "../domain/types.js";
import { StageDeferredError, type DescriptionEvidence } from "../scheduler/orchestrator.js";
import { isCounterclockwiseArtifact } from "./artifactNaming.js";

// The descriptor's llama-server holds about 11 GB of RAM while describing; on a
// machine short of memory the kernel kills it and the stage would fail.
const DESCRIBE_MIN_AVAILABLE_GIB = Number(process.env.VIDEO_PIPELINE_DESCRIBE_MIN_MEMORY_GIB ?? 16);

// fstrim discards every free block of the filesystem; after a reboot that is all the free
// space (760 GiB here, 3.5 to 4.5 hours each week). Meanwhile this disk reads at about
// 15 MB/s: on 2026-11-23 every model start during it took 6.5 to 10 minutes instead of
// seconds, and one passed the 10-minute limit. Describing waits for the trim to finish.
export async function diskTrimRunning(proc = "/proc"): Promise<boolean> {
    for (const entry of await readdir(proc).catch(() => [] as string[])) {
        if (!/^\d+$/.test(entry)) continue;
        if ((await readFile(`${proc}/${entry}/comm`, "utf8").catch(() => "")).trim() === "fstrim") return true;
    }
    return false;
}

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
    let result;
    try {
        result = await describeArtifact(artifact.path, {
            evidenceKey: artifact.sha256,
            avoidPhrases,
            // Only a description that is not cached starts the model server.
            beforeWork: async () => {
                const available = await availableMemoryBytes();
                if (available !== null && available < DESCRIBE_MIN_AVAILABLE_GIB * 2 ** 30) {
                    // A stable message: the campaign logs a waiting step only when it changes.
                    throw new StageDeferredError(`waiting for ${DESCRIBE_MIN_AVAILABLE_GIB} GiB of available memory before starting the descriptor`);
                }
                if (await diskTrimRunning()) throw new StageDeferredError("waiting for fstrim to finish trimming the disk before starting the descriptor");
            },
            ...(isCounterclockwiseArtifact(artifact.path) ? { rotation: "clockwise" as const } : {}),
        });
    } catch (error) {
        if (!(error instanceof DescriptorStartupError)) throw error;
        // The model did not start: a matter of the machine at that moment, not of this video.
        // The recording keeps its state and is described on a later step; the server's own
        // output goes to the journal for the daily check.
        console.log(JSON.stringify({ event: "descriptor-start-failed", recordingId: artifact.recordingId, error: error.message }));
        throw new StageDeferredError("the description model did not start; trying again (descriptor-start-failed in the journal)");
    }
    return {
        artifactSha256: artifact.sha256,
        promptVersion: result.promptVersion,
        fps: result.fps,
        output: result.description,
        evidencePath: result.evidencePath,
    };
}
