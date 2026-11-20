// The upload metadata the core composes: the descriptor's title with the recording's
// "[<folder>]" stamp (how a destination's own uploads are recognized), the description
// with the content profile's footer, and the profile's tags; long text is shortened to the
// limits without losing the stamp or the footer.
import assert from "node:assert/strict";
import test from "node:test";

import { composeUploadMetadata, uploadLookupIdentity } from "../dist/metadata/composeUploadMetadata.js";

const recording = (provider, folder) => ({
    id: "c".repeat(64), provider, sourcePath: `/synthetic/${provider}/downloaded/${folder}`,
});
// Extra whitespace and descriptor tags are part of the fixture on purpose.
const description = { output: {
    title: "  Two players   trade long baseline rallies  ",
    description: "A synthetic   description.\nSecond line.",
    tags: ["ignored", "Also Ignored"],
} };

test("full upload metadata, with the alias line", () => {
    assert.deepEqual(composeUploadMetadata(recording("live-a", "2026-03-04 050607 centre_court"), description,
        { status: "resolved", streamerUrl: "https://live-a.example/court/1", aliasUrl: "https://live-a.example/centre_court" }), {
        title: "Two players trade long baseline rallies [2026-03-04 050607 centre_court]",
        description: "A synthetic description. Second line.\n\n"
            + "Recorded: 2026-03-04 05:06:07\nSource: https://live-a.example/court/1\nAlias: https://live-a.example/centre_court",
        tags: ["live-a", "tennis"],
    });
});

test("an unresolved source keeps the placeholder; parts from earlier policies have no lookup identity", () => {
    assert.deepEqual(composeUploadMetadata(recording("live-c", "synthetic folder"), description,
        { status: "review_required", reason: "identifier_not_resolved_by_server", streamerUrl: null, aliasUrl: null }), {
        title: "Two players trade long baseline rallies [synthetic folder]",
        description: "A synthetic description. Second line.\n\nRecorded: unknown\nSource: unknown",
        tags: ["live-c", "tennis"],
    });
    const live = recording("live-a", "2026-03-04 050607 centre_court");
    const legacy = composeUploadMetadata(live, description,
        { status: "resolved", streamerUrl: "https://live-a.example/court/1", aliasUrl: null }, "nonmax1080p");
    assert.equal(legacy.title, "Two players trade long baseline rallies [2026-03-04 050607 centre_court]");
    assert.equal(uploadLookupIdentity(live, "nonmax1080p", legacy.title), null);
});

test("shortening keeps the stamp and footer inside the 255/1000 limits", () => {
    const metadata = composeUploadMetadata(recording("live-a", "2026-03-04 050607 centre_court"),
        { output: { title: "word ".repeat(80), description: "sentence ".repeat(200) } },
        { status: "resolved", streamerUrl: "https://live-a.example/court/1", aliasUrl: null });
    assert.ok(metadata.title.endsWith("… [2026-03-04 050607 centre_court]"));
    assert.ok(metadata.title.length <= 255);
    assert.ok(metadata.description.endsWith("…\n\nRecorded: 2026-03-04 05:06:07\nSource: https://live-a.example/court/1"));
    assert.ok(metadata.description.length <= 1000);
});
