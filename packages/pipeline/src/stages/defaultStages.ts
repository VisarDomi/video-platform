import type { PipelineStages } from "../scheduler/orchestrator.js";
import { describeValidatedArtifact } from "./describe.js";
import { artifactRecipeReason, reuseCachedArtifact, retainUnprovenArtifact, type ArtifactCacheConfig } from "./artifactCache.js";
import { analyzeRecordingResolution, planRecordingShapes } from "./resolutionPolicy.js";
import { convertShapeGroup } from "./upscale.js";
import { validateArtifact } from "./validateArtifact.js";
import { productionArtifactSuffix } from "./artifactNaming.js";

export function createDefaultStages(stagingRoot: string, cacheConfig?: ArtifactCacheConfig): PipelineStages {
    return {
        // Every recording is converted; no segment is dropped. One shape is one
        // artifact; several shapes are one artifact each, uploaded one after
        // another; short pieces enter automatic joining before upload.
        remux: async (recording) => {
            const cached = cacheConfig ? await reuseCachedArtifact(recording, stagingRoot, cacheConfig) : null;
            if (cached) return { disposition: "artifact", ...cached };
            const analysis = await analyzeRecordingResolution(recording.playlistPath);
            const plan = planRecordingShapes(analysis);
            const reason = artifactRecipeReason(plan.reason.replace(/under 60s: manual handling, not uploaded/g,
                "short shape: automatic same-streamer joining before upload"));
            // Small shape pieces are converted too; the campaign pools them
            // automatically instead of dropping them into manual review.
            const groups = [...plan.upload, ...plan.manual].sort((a, b) => a.ordinal - b.ordinal);
            if (groups.length === 1 && groups[0].part === "full") {
                const group = groups[0];
                await retainUnprovenArtifact(stagingRoot, recording.id, productionArtifactSuffix(group.part, group.output.rotate));
                const converted = await convertShapeGroup(recording.playlistPath, stagingRoot, recording.id, group,
                    productionArtifactSuffix(group.part, group.output.rotate), analysis);
                return { disposition: "artifact", path: converted.path, eventReason: reason };
            }
            const parts = [];
            for (const group of groups) {
                await retainUnprovenArtifact(stagingRoot, recording.id, productionArtifactSuffix(group.part, group.output.rotate));
                const converted = await convertShapeGroup(recording.playlistPath, stagingRoot, recording.id, group,
                    productionArtifactSuffix(group.part, group.output.rotate), analysis, group.indexes);
                const validated = await validateArtifact(converted.path);
                parts.push({
                    part: group.part as Exclude<typeof group.part, "full">,
                    path: validated.path,
                    sizeBytes: validated.sizeBytes,
                    sha256: validated.sha256,
                    validatedAt: validated.validatedAt,
                    segmentCount: group.segmentCount,
                    sourceDimensions: group.sourceDimensions,
                });
            }
            return { disposition: "artifact_set", reason, primary: parts[0], queued: parts.slice(1) };
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
