import type { PipelineStages } from "../scheduler/orchestrator.js";
import { describeValidatedArtifact } from "./describe.js";
import { artifactRecipeReason, reuseCachedArtifact, type ArtifactCacheConfig } from "./artifactCache.js";
import { analyzeRecordingResolution, planRecordingShapes, type ShapeGroup } from "./resolutionPolicy.js";
import { convertShapeGroup } from "./upscale.js";
import { validateArtifact } from "./validateArtifact.js";
import { productionArtifactSuffix } from "./artifactNaming.js";

function manualPiece(group: ShapeGroup) {
    return {
        part: group.part,
        segmentIndexes: [...group.indexes].sort((a, b) => a - b),
        durationSeconds: group.durationSeconds,
        sourceDimensions: group.sourceDimensions,
    };
}

export function createDefaultStages(stagingRoot: string, cacheConfig?: ArtifactCacheConfig): PipelineStages {
    return {
        // Every recording is converted; no segment is dropped. One shape is one
        // artifact; several shapes are one artifact each, uploaded one after
        // another; a split's pieces under a minute wait for a person.
        remux: async (recording) => {
            const cached = cacheConfig ? await reuseCachedArtifact(recording, stagingRoot, cacheConfig) : null;
            if (cached) return { disposition: "artifact", ...cached };
            const analysis = await analyzeRecordingResolution(recording.playlistPath);
            const plan = planRecordingShapes(analysis);
            const reason = artifactRecipeReason(plan.reason);
            const manualPieces = plan.manual.map(manualPiece);
            if (plan.upload.length === 0) {
                return { disposition: "manual", reason: `${reason}; no piece is long enough to upload`, manualPieces };
            }
            if (plan.upload.length === 1 && plan.upload[0].part === "full") {
                const group = plan.upload[0];
                const converted = await convertShapeGroup(recording.playlistPath, stagingRoot, recording.id, group,
                    productionArtifactSuffix(group.part, group.output.rotate), analysis);
                return { disposition: "artifact", path: converted.path, eventReason: reason };
            }
            const parts = [];
            for (const group of plan.upload) {
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
            return { disposition: "artifact_set", reason, primary: parts[0], queued: parts.slice(1), manualPieces };
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
