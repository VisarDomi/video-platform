import { readFile } from "node:fs/promises";
import { loadDestinationPlugin, parseDestinations, type Destination } from "sdk";
import { journalPriority, sitesFilePath, type UploadLimits } from "shared";

// What the core needs to know about a destination before it opens a session: its upload
// limits and visibility, and when its remote copy comes into existence. They come from the
// destination's plug-in, named by the sites file.
export interface DestinationFacts {
    readonly creationBoundary: Destination["creationBoundary"];
    readonly policy: UploadLimits;
    readonly uploadVisibility: "public" | "private";
}

// Never-submitted attempts of the active destination back in the queue, when its creation
// boundary says they published nothing. Facts that cannot be read (a broken sites file, a
// stale plug-in build) skip this once, said in the journal, instead of stopping the
// caller's other work: the attempts stay uncertain and are confirmed as usual.
export async function settleUnsubmitted(database: { getActiveUploadProvider(): string;
    settleUnsubmittedAttempts(provider: string, boundary: Destination["creationBoundary"], now?: Date): string[] }, now = new Date()): Promise<string[]> {
    const provider = database.getActiveUploadProvider();
    let boundary: Destination["creationBoundary"];
    try { boundary = (await destinationFacts(provider)).creationBoundary; } catch (error) {
        console.error(journalPriority("warn") + JSON.stringify({ event: "destination-facts-unavailable", provider,
            error: error instanceof Error ? error.message : String(error) }));
        return [];
    }
    return database.settleUnsubmittedAttempts(provider, boundary, now);
}

export async function destinationFacts(provider: string): Promise<DestinationFacts> {
    const file = sitesFilePath();
    const entry = parseDestinations(await readFile(file, "utf8"), file).find((destination) => destination.id === provider);
    if (!entry) throw new Error(`The sites file names no destination "${provider}"`);
    const plugin = await loadDestinationPlugin(entry);
    if (plugin.creationBoundary !== "metadata_submit" && plugin.creationBoundary !== "transfer_start") {
        throw new Error(`Destination ${provider}: ${entry.plugin} declares no creation boundary (a build older than this pipeline?)`);
    }
    if (!plugin.policy) throw new Error(`Destination ${provider}: ${entry.plugin} declares no upload policy (a build older than this pipeline?)`);
    const { minimumDurationSeconds, maximumDurationSeconds, maximumFileBytes, uploadVisibility } = plugin.policy;
    return {
        creationBoundary: plugin.creationBoundary,
        policy: { destination: provider, minimumDurationSeconds, maximumDurationSeconds, maximumFileBytes },
        uploadVisibility,
    };
}
