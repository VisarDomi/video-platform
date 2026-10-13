import type { ProductionArtifactPart } from "../domain/types.js";

// Production artifact file suffixes: "<recording>.production-v6[-shapeN][-ccw].mp4".
// "-ccw" marks a portrait picture turned 90° counterclockwise; the describe
// stage turns it back for the model. A new name per policy keeps any older
// artifact (or a half-written one) from being adopted by mistake.
export const PRODUCTION_ARTIFACT_BASE = "production-v6";

export function productionArtifactSuffix(part: ProductionArtifactPart, rotate: boolean): string {
    return `${PRODUCTION_ARTIFACT_BASE}${part === "full" ? "" : `-${part}`}${rotate ? "-ccw" : ""}`;
}

export function isCounterclockwiseArtifact(artifactPath: string): boolean {
    // Artifacts of earlier policies keep their names.
    return /\.production-v\d+(?:-shape\d+)?-ccw\.mp4$/.test(artifactPath);
}
