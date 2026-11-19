import { promises as fs } from "node:fs";
import { SDK_VERSION } from "./plugin.js";

// ---- Content profile ------------------------------------------------------------------
//
// What a deployment says about its recordings: the descriptor's prompt, model and output
// bounds, the footer under each description and the tags. The core keeps what identifies
// an upload (the "[<recording folder>]" title stamp, the duplicate guard) and the
// composition itself (shortening to the destination's limits).

// The facts about one recording a profile may use.
export interface RecordingFacts {
    // The sites-file ID of the site the recording came from.
    siteId: string;
    // The recording folder's name: "<YYYY-MM-DD HHMMSS> <channel>".
    folderName: string;
    // "YYYY-MM-DD HH:MM:SS" from the folder name, or "unknown".
    recordedAt: string;
    // The channel's page, or null while the recording's provenance is still unresolved
    // and a placeholder is allowed.
    sourceUrl: string | null;
    // The channel's page under its alias, when it has one.
    aliasUrl: string | null;
}

// Bounds of the descriptor's JSON output, enforced by the model request and re-checked
// after a rewrite.
export interface DescriptorOutputBounds {
    titleMinLength: number;
    titleMaxLength: number;
    descriptionMinLength: number;
    descriptionMaxLength: number;
}

export interface DescriptorSettings {
    // The base prompt file. Its exact bytes (plus learned phrases) are the prompt version,
    // which keys every cached description: changing one byte re-describes everything.
    promptFile: string;
    // The model and its projector, relative to <services data root>/models (or absolute).
    modelFile: string;
    projectorFile: string;
    // The model name sent with each request.
    requestModel: string;
    output: DescriptorOutputBounds;
}

export interface ContentProfile {
    id: string;
    descriptor: DescriptorSettings;
    // The lines under the descriptor's text in every description.
    descriptionFooter(facts: RecordingFacts): string;
    // Every upload's tags. Descriptor tags are never used.
    tags(facts: RecordingFacts): string[];
}

export interface ContentProfilePlugin {
    id: string;
    sdkVersion: typeof SDK_VERSION;
    create(): ContentProfile;
}

// The package of the deployment's content profile, from its sites file:
//
//   { "contentProfile": "profile-tennis", "sites": [ ... ] }
//
// null when the file names none.
export function parseContentProfileName(text: string, source = "sites file"): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error: any) {
        throw new Error(`${source}: invalid JSON (${error.message})`);
    }
    const name = (parsed as { contentProfile?: unknown } | null)?.contentProfile;
    if (name === undefined) return null;
    if (typeof name !== "string" || !name) throw new Error(`${source}: contentProfile must be a package name`);
    return name;
}

export async function loadContentProfile(
    sitesFile: string,
    importPlugin: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<ContentProfile> {
    const name = parseContentProfileName(await fs.readFile(sitesFile, "utf-8"), sitesFile);
    if (!name) throw new Error(`${sitesFile}: no "contentProfile" (the package that describes this deployment's recordings)`);
    const module = await importPlugin(name) as { default?: unknown; profile?: unknown };
    const plugin = (module.profile ?? module.default) as ContentProfilePlugin | undefined;
    if (!plugin || typeof plugin.create !== "function") throw new Error(`Content profile ${name} does not export a profile`);
    if (plugin.sdkVersion !== SDK_VERSION) {
        throw new Error(`Content profile ${name} targets SDK ${plugin.sdkVersion}, this core runs SDK ${SDK_VERSION}`);
    }
    return plugin.create();
}
