import type { PipelineStages } from "../scheduler/orchestrator.js";
import { describeValidatedArtifact } from "./describe.js";
import { streamCopyRemux } from "./remux.js";
import { artifactRecipeReason, reuseCachedArtifact, type ArtifactCacheConfig } from "./artifactCache.js";
import {
    analyzeRecordingResolution,
    chooseRecordingResolutionPolicy,
} from "./resolutionPolicy.js";
import { upscaleWholeRecordingTo1080 } from "./upscale.js";
import { validateArtifact } from "./validateArtifact.js";

export function createDefaultStages(stagingRoot: string, cacheConfig?: ArtifactCacheConfig): PipelineStages {
    return {
        remux: async (recording) => {
            const cached = cacheConfig ? await reuseCachedArtifact(recording, stagingRoot, cacheConfig) : null;
            if (cached) return { disposition: "artifact", ...cached };
            const analysis = await analyzeRecordingResolution(recording.playlistPath);
            const policy = chooseRecordingResolutionPolicy(analysis);
            if (policy.disposition === "convert1080") {
                const transcoded = await upscaleWholeRecordingTo1080(
                    recording.playlistPath,
                    stagingRoot,
                    recording.id,
                    policy.source,
                    undefined,
                    analysis,
                );
                return {
                    disposition: "artifact",
                    path: transcoded.path,
                    eventReason: artifactRecipeReason(policy.reason),
                };
            }
            if (policy.disposition === "remuxNative") {
                return {
                    disposition: "artifact",
                    path: await streamCopyRemux(recording.playlistPath, stagingRoot, recording.id, undefined, { analysis }),
                    eventReason: artifactRecipeReason(policy.reason),
                };
            }
            return {
                disposition: "artifact",
                path: await streamCopyRemux(recording.playlistPath, stagingRoot, recording.id, "retained1080p",
                    { analysis, keepIndexes: policy.retainedSegmentIndexes }),
                eventReason: artifactRecipeReason(policy.reason),
            };
        },
        validateArtifact: async (_recording, artifactPath) => {
            const artifact = await validateArtifact(artifactPath);
            return {
                path: artifact.path,
                sizeBytes: artifact.sizeBytes,
                sha256: artifact.sha256,
                validatedAt: artifact.validatedAt,
            };
        },
        describe: (_recording, artifact) => describeValidatedArtifact(artifact),
    };
}
