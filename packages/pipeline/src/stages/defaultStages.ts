import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { PipelineStages } from "../scheduler/orchestrator.js";
import { describeValidatedArtifact } from "./describe.js";
import { streamCopyRemux } from "./remux.js";
import {
    analyzeRecordingResolution,
    chooseRecordingResolutionPolicy,
    deriveResolutionPlaylist,
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
                );
                return {
                    disposition: "artifact",
                    path: transcoded.path,
                    eventReason: resolutionPolicyReason(policy.reason),
                };
            }
            if (policy.disposition === "remux1080") {
                return {
                    disposition: "artifact",
                    path: await streamCopyRemux(recording.playlistPath, stagingRoot, recording.id),
                    eventReason: resolutionPolicyReason(policy.reason),
                };
            }
            await fs.mkdir(path.resolve(stagingRoot), { recursive: true });
            const temporaryStem = path.join(
                path.resolve(stagingRoot),
                `.${recording.id}.${randomUUID()}`,
            );
            const maxPlaylist = `${temporaryStem}.retained1080p.m3u8`;
            try {
                await fs.writeFile(
                    maxPlaylist,
                    deriveResolutionPlaylist(analysis, policy.maxSegmentIndexes),
                    { encoding: "utf8", flag: "wx" },
                );
                return {
                    disposition: "artifact",
                    path: await streamCopyRemux(maxPlaylist, stagingRoot, recording.id, "retained1080p"),
                    eventReason: resolutionPolicyReason(policy.reason),
                };
            } finally {
                await fs.unlink(maxPlaylist).catch(() => undefined);
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
        describe: (_recording, artifact) => describeValidatedArtifact(artifact),
    };
}
