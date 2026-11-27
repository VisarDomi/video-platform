import { readdir, readFile } from "node:fs/promises";
import { describeArtifact, DescriptorStartupError } from "descriptor";
import type { ArtifactRecord } from "../domain/types.js";
import { StageDeferredError, type DescriptionEvidence } from "../scheduler/orchestrator.js";
import { isCounterclockwiseArtifact } from "./artifactNaming.js";
import { sharedDescriptionModel } from "./descriptionModel.js";
import { shutdownSignal } from "../shutdown.js";

// The descriptor's llama-server holds about 11 GB of RAM while describing; on a
// machine short of memory the kernel kills it and the stage would fail.
const DESCRIBE_MIN_AVAILABLE_GIB = Number(process.env.VIDEO_PIPELINE_DESCRIBE_MIN_MEMORY_GIB ?? 16);
// A model that fails to start this many times in a row for one recording is not a passing
// state of the machine (a missing runtime, a broken model): the recording fails, visibly.
export const DESCRIBE_START_ATTEMPTS = 3;
const failedStarts = new Map<string, number>();

// Whether a process's cgroup (or any ancestor slice) enforces a finite write/discard IOPS cap.
async function hasWriteIopsCap(proc: string, pid: string, cgroupRoot: string): Promise<boolean> {
    const raw = await readFile(`${proc}/${pid}/cgroup`, "utf8").catch(() => "");
    const rel = raw.match(/^0::(\/.*)$/m)?.[1];
    if (!rel) return false;
    let current = rel;
    while (current && current !== "/") {
        const ioMax = await readFile(`${cgroupRoot}${current}/io.max`, "utf8").catch(() => "");
        if (/\bwiops=\d+\b/.test(ioMax)) return true;
        const slash = current.lastIndexOf("/");
        current = slash > 0 ? current.slice(0, slash) : "/";
    }
    return false;
}

// An uncapped fstrim can saturate disk I/O enough to slow cold model reads past the startup
// timeout. Describing waits while an uncapped fstrim runs; a slice-capped fstrim (finite
// wiops in io.max) leaves enough read bandwidth and does not block describing.
export async function diskTrimRunning(proc = "/proc", cgroupRoot = "/sys/fs/cgroup"): Promise<boolean> {
    for (const entry of await readdir(proc).catch(() => [] as string[])) {
        if (!/^\d+$/.test(entry)) continue;
        if ((await readFile(`${proc}/${entry}/comm`, "utf8").catch(() => "")).trim() !== "fstrim") continue;
        if (!await hasWriteIopsCap(proc, entry, cgroupRoot)) return true;
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
    const turns = sharedDescriptionModel();
    const describe = () => describeArtifact(artifact.path, {
        evidenceKey: artifact.sha256,
        avoidPhrases,
        // A service stop ends the description (and its model, even one still loading) at once.
        signal: shutdownSignal,
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
    try {
        result = await (turns ? turns.take(describe) : describe());
    } catch (error) {
        if (!(error instanceof DescriptorStartupError)) throw error;
        // The model did not start: a matter of the machine at that moment, not of this video.
        // The recording keeps its state and is described on a later step; the server's own
        // output goes to the journal for the daily check.
        const attempts = (failedStarts.get(artifact.recordingId) ?? 0) + 1;
        console.log(JSON.stringify({ event: "descriptor-start-failed", recordingId: artifact.recordingId, attempt: attempts, error: error.message }));
        if (attempts >= DESCRIBE_START_ATTEMPTS) { failedStarts.delete(artifact.recordingId); throw error; }
        failedStarts.set(artifact.recordingId, attempts);
        throw new StageDeferredError("the description model did not start; trying again (descriptor-start-failed in the journal)");
    }
    failedStarts.delete(artifact.recordingId);
    return {
        artifactSha256: artifact.sha256,
        promptVersion: result.promptVersion,
        fps: result.fps,
        output: result.description,
        evidencePath: result.evidencePath,
    };
}
