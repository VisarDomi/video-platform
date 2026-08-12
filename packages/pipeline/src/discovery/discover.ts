import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import { scanFinalizedRoots, type DiscoveryRoot, type FinalizedInspectionResult } from "./inspectRecording.js";

export async function planDiscovery(
    roots: readonly DiscoveryRoot[],
): Promise<FinalizedInspectionResult[]> {
    return await scanFinalizedRoots(roots);
}

export function applyDiscovery(database: PipelineDatabase, plan: readonly FinalizedInspectionResult[]): {
    discovered: number;
    excluded: number;
} {
    let discovered = 0;
    let excluded = 0;
    for (const result of plan) {
        if (result.status === "finalized") {
            database.discover(result.recording);
            discovered++;
        } else {
            excluded++;
        }
    }
    return { discovered, excluded };
}
