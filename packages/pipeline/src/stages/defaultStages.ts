import type { PipelineStages } from "../scheduler/orchestrator.js";
import { describeValidatedArtifact } from "./describe.js";
import { streamCopyRemux } from "./remux.js";
import {
    analyzeRecordingResolution,
    chooseRecordingResolutionPolicy,
    resolutionPolicyReason,
} from "./resolutionPolicy.js";
import { upscaleWholeRecordingTo1080 } from "./upscale.js";
import { validateArtifact } from "./validateArtifact.js";

export function createDefaultStages(stagingRoot: string): PipelineStages {
    return {
        remux: async (recording) => {
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
                    eventReason: resolutionPolicyReason(policy.reason),
                };
            }
            if (policy.disposition === "remuxNative") {
                return {
                    disposition: "artifact",
                    path: await streamCopyRemux(recording.playlistPath, stagingRoot, recording.id, undefined, { analysis }),
                    eventReason: resolutionPolicyReason(policy.reason),
                };
            }
            return {
                disposition: "artifact",
                path: await streamCopyRemux(recording.playlistPath, stagingRoot, recording.id, "retained1080p",
                    { analysis, keepIndexes: policy.retainedSegmentIndexes }),
                eventReason: resolutionPolicyReason(policy.reason),
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
