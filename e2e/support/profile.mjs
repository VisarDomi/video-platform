// The e2e's own content profile (not profiles/tennis): a fixed prompt, a model the
// fake model server stands in for, and plain footer and tags. The sites file names it by
// file URL.
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "sdk";

export const profile = {
    id: "e2e",
    sdkVersion: SDK_VERSION,
    create: () => ({
        id: "e2e",
        descriptor: {
            promptFile: fileURLToPath(new URL("./prompt.txt", import.meta.url)),
            modelFile: "e2e-model.gguf",
            projectorFile: "e2e-mmproj.gguf",
            requestModel: "e2e-model",
            output: { titleMinLength: 5, titleMaxLength: 100, descriptionMinLength: 20, descriptionMaxLength: 750 },
        },
        descriptionFooter: (facts) => `Recorded: ${facts.recordedAt}\nSource: ${facts.sourceUrl ?? "unknown"}`,
        tags: (facts) => [facts.siteId, "tennis"],
    }),
};
export default profile;
