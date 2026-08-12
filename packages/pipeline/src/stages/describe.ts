import { describeArtifact } from "descriptor";
import type { ArtifactRecord } from "../domain/types.js";
import type { DescriptionEvidence } from "../scheduler/orchestrator.js";

export async function describeValidatedArtifact(artifact: ArtifactRecord): Promise<DescriptionEvidence> {
    const result = await describeArtifact(artifact.path, { evidenceKey: artifact.sha256 });
    return {
        artifactSha256: artifact.sha256,
        promptVersion: result.promptVersion,
        fps: result.fps,
        output: result.description,
        evidencePath: result.evidencePath,
    };
}
