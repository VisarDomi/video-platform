import { describeArtifact } from "descriptor";
import type { ArtifactRecord } from "../domain/types.js";
import type { DescriptionEvidence } from "../scheduler/orchestrator.js";
import { isCounterclockwiseArtifact } from "./artifactNaming.js";

export async function describeValidatedArtifact(
    artifact: ArtifactRecord,
    avoidPhrases: readonly string[] = [],
): Promise<DescriptionEvidence> {
    // A portrait picture was turned counterclockwise for upload; the model
    // reads it lying on its side, so it is shown the picture turned back.
    const result = await describeArtifact(artifact.path, {
        evidenceKey: artifact.sha256,
        avoidPhrases,
        ...(isCounterclockwiseArtifact(artifact.path) ? { rotation: "clockwise" as const } : {}),
    });
    return {
        artifactSha256: artifact.sha256,
        promptVersion: result.promptVersion,
        fps: result.fps,
        output: result.description,
        evidencePath: result.evidencePath,
    };
}
