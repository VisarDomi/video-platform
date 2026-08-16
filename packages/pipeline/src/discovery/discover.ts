import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import { scanFinalizedRoots, type DiscoveryRoot, type FinalizedInspectionResult } from "./inspectRecording.js";
import type { TargetCatalogResolver } from "../provenance/targetResolver.js";

export async function planDiscovery(
    roots: readonly DiscoveryRoot[],
): Promise<FinalizedInspectionResult[]> {
    return await scanFinalizedRoots(roots);
}

export async function applyDiscovery(
    database: PipelineDatabase,
    plan: readonly FinalizedInspectionResult[],
    resolver?: TargetCatalogResolver,
): Promise<{
    discovered: number;
    excluded: number;
}> {
    let discovered = 0;
    let excluded = 0;
    for (const result of plan) {
        if (result.status === "finalized") {
            const recording = database.discover(result.recording);
            if (resolver) {
                const resolved = await resolver.resolve(result.recording);
                database.saveProvenance(recording.id,
                    database.getProvenanceOverride(result.recording.provider, resolved.observedIdentifier) ?? resolved);
            }
            discovered++;
        } else {
            excluded++;
        }
    }
    return { discovered, excluded };
}
