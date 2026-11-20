import { readFile } from "node:fs/promises";
import { loadDestinationPlugin, parseDestinations, type Destination } from "sdk";
import { PROVIDER_UPLOAD_POLICIES, policyForUploadProvider, sitesFilePath, type SharedUploadPolicy } from "shared";

// What the core needs to know about a destination before it opens a session: its upload
// limits and visibility, and when its remote copy comes into existence. They come from the
// destination's plug-in (named by the sites file); VideoHost's limits are the core's pinned
// table in shared, which wins for it.
export interface DestinationFacts {
    readonly creationBoundary: Destination["creationBoundary"];
    readonly policy: SharedUploadPolicy;
    readonly uploadVisibility: "public" | "private";
}

export async function destinationFacts(provider: string): Promise<DestinationFacts> {
    const file = sitesFilePath();
    const entry = parseDestinations(await readFile(file, "utf8"), file).find((destination) => destination.id === provider);
    if (!entry) throw new Error(`The sites file names no destination "${provider}"`);
    const plugin = await loadDestinationPlugin(entry);
    if (Object.hasOwn(PROVIDER_UPLOAD_POLICIES, provider)) {
        const pinned = PROVIDER_UPLOAD_POLICIES[provider as keyof typeof PROVIDER_UPLOAD_POLICIES];
        return { creationBoundary: plugin.creationBoundary, policy: policyForUploadProvider(provider), uploadVisibility: pinned.uploadVisibility ?? "private" };
    }
    if (!plugin.policy) throw new Error(`Destination ${provider}: ${entry.plugin} declares no upload policy`);
    const { minimumDurationSeconds, maximumDurationSeconds, maximumFileBytes, uploadVisibility } = plugin.policy;
    return {
        creationBoundary: plugin.creationBoundary,
        policy: { providers: [], minimumDurationSeconds, maximumDurationSeconds, maximumFileBytes, unresolvedConstraints: [] },
        uploadVisibility,
    };
}
