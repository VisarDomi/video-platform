import type { PipelineStages } from "../scheduler/orchestrator.js";
import { describeValidatedArtifact } from "./describe.js";
import { streamCopyRemux } from "./remux.js";
import { ServerAuthorityClient } from "./serverAuthority.js";
import { validateArtifact } from "./validateArtifact.js";

export function createDefaultStages(
    stagingRoot: string,
    authority = new ServerAuthorityClient(),
): PipelineStages {
    return {
        repairPlaylist: (recording) => authority.repairPlaylist(recording),
        confirmIntegrity: (recording) => authority.confirmIntegrity(recording),
        remux: (recording) => streamCopyRemux(recording.playlistPath, stagingRoot, recording.id),
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
