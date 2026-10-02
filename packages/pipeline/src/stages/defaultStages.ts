import type { PipelineStages } from "../scheduler/orchestrator.js";
import { describeValidatedArtifact } from "./describe.js";
import { streamCopyRemux } from "./remux.js";
import { artifactRecipeReason, reuseCachedArtifact, type ArtifactCacheConfig } from "./artifactCache.js";
import {
    analyzeRecordingResolution,
    chooseRecordingResolutionPolicy,
    conversionReferenceSource,
} from "./resolutionPolicy.js";
import { upscaleWholeRecordingTo1080 } from "./upscale.js";
import { validateArtifact } from "./validateArtifact.js";
import { RemuxCompatibilityError } from "./mediaCompatibility.js";

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
            try {
                return {
                    disposition: "artifact",
                    path: await streamCopyRemux(recording.playlistPath, stagingRoot, recording.id,
                        policy.disposition === "retain1080" ? "retained1080p" : undefined, {
                            analysis, keepIndexes: policy.disposition === "retain1080" ? policy.retainedSegmentIndexes : undefined,
                        }),
                    eventReason: artifactRecipeReason(policy.reason),
                };
            } catch (error) {
                if (!(error instanceof RemuxCompatibilityError)) throw error;
                const keepIndexes = policy.disposition === "retain1080" ? policy.retainedSegmentIndexes : undefined;
                const selected = analysis.segments.filter(segment => !keepIndexes || keepIndexes.has(segment.index));
                // Reuse the normal conversion's no-stretch/no-padding aspect
                // guard, while preserving the original 90% selection.
                const transcoded = await upscaleWholeRecordingTo1080(recording.playlistPath, stagingRoot, recording.id,
                    conversionReferenceSource(selected), "compatibility-upscale1080p", analysis, keepIndexes);
                return { disposition: "artifact", path: transcoded.path,
                    eventReason: artifactRecipeReason(`${policy.reason}; compatibility-conversion-v1: ${error.message}`) };
            }
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
        describe: (_recording, artifact, avoidPhrases) => describeValidatedArtifact(artifact, avoidPhrases),
    };
}
