import { configureDescriptor } from "descriptor";
import { loadContentProfile, type ContentProfile } from "sdk";
import { sitesFilePath } from "shared";

// The deployment's content profile (named by its sites file): the descriptor's prompt and
// model, and the footer and tags of every upload's metadata. Loaded once per process.

let active: ContentProfile | null = null;
let loadError: unknown = null;

// Makes `profile` the process's content profile and configures the descriptor with it.
export function useContentProfile(profile: ContentProfile): ContentProfile {
    active = profile;
    loadError = null;
    configureDescriptor(profile.descriptor);
    return profile;
}

// Loads the profile the sites file names. A failure is kept: commands that need the
// profile fail with it at their first use, and those that don't (session upkeep,
// reports) keep working.
export async function initContentProfile(): Promise<ContentProfile | null> {
    if (active) return active;
    try {
        return useContentProfile(await loadContentProfile(sitesFilePath()));
    } catch (error) {
        loadError = error;
        return null;
    }
}

export function contentProfile(): ContentProfile {
    if (active) return active;
    throw loadError instanceof Error
        ? new Error(`No content profile: ${loadError.message}`, { cause: loadError })
        : new Error("No content profile: initContentProfile() has not run");
}
