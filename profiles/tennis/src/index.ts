import path from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION, type ContentProfile, type ContentProfilePlugin, type RecordingFacts } from "sdk";

// The tennis content profile: what the simulated tournament sites' recordings are
// described with. The descriptor watches each match with a local vision model; the footer
// and tags come from the recording's own facts. A profile's prompt bytes key every cached
// description, so editing the prompt re-describes everything.

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelDirectory = "gemma-4-e4b";

function descriptionFooter(facts: RecordingFacts): string {
    return [
        `Recorded: ${facts.recordedAt}`,
        `Source: ${facts.sourceUrl ?? "unknown"}`,
        ...(facts.aliasUrl ? [`Alias: ${facts.aliasUrl}`] : []),
    ].join("\n");
}

export const profile: ContentProfilePlugin = {
    id: "tennis",
    sdkVersion: SDK_VERSION,
    create(): ContentProfile {
        return {
            id: "tennis",
            descriptor: {
                promptFile: path.join(packageDirectory, "prompts", "match-description.txt"),
                modelFile: path.join(modelDirectory, "gemma-4-E4B-it-Q8_0.gguf"),
                projectorFile: path.join(modelDirectory, "mmproj-gemma-4-E4B-it-F16.gguf"),
                requestModel: "gemma-4-E4B-it-Q8_0",
                output: { titleMinLength: 5, titleMaxLength: 100, descriptionMinLength: 20, descriptionMaxLength: 750 },
            },
            descriptionFooter,
            // The site the match was recorded from, and the sport.
            tags: (facts) => [facts.siteId, "tennis"],
        };
    },
};

export default profile;
