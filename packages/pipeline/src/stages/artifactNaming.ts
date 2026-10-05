import type { ProductionArtifactPart } from "../domain/types.js";

// Production artifact file suffixes: "<recording>.production-v5[-shapeN][-ccw].mp4".
// "-ccw" marks a portrait picture turned 90° counterclockwise; the describe
// stage turns it back for the model. A new name per policy keeps any older
// artifact (or a half-written one) from being adopted by mistake.
export const PRODUCTION_ARTIFACT_BASE = "production-v5";

export function productionArtifactSuffix(part: ProductionArtifactPart, rotate: boolean): string {
    return `${PRODUCTION_ARTIFACT_BASE}${part === "full" ? "" : `-${part}`}${rotate ? "-ccw" : ""}`;
}

export function isCounterclockwiseArtifact(artifactPath: string): boolean {
    return /\.production-v5(?:-shape\d+)?-ccw\.mp4$/.test(artifactPath);
}
