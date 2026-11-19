// Pinning tests: values production matches against what it uploaded or converted
// before. The title bracket stamp is how the destination's own uploads are
// recognized (a change lets duplicates through); the production geometry decides
// what every artifact looks like (a change re-encodes everything once the policy
// version is bumped). Change them only on purpose.
//
// Already pinned elsewhere, not repeated here:
//   RESOLUTION_POLICY_VERSION + ARTIFACT_RECIPE_VERSION: artifactCache.test.mjs
//     ("resolution-policy-v6: [artifact-recipe-v4] artifact cache hit"), shapeSplit.test.mjs
//   CURRENT_PRODUCTION_VERSION: pipelineDatabase.test.mjs, campaign.test.mjs
//   "-ccw" / "-shapeN" artifact names: shapeSplit.test.mjs (productionArtifactSuffix, isCounterclockwiseArtifact)
//   720x1280, 640x480, 1280x720 production sizes: v4.test.mjs
//   matchesVideoHostIdentity: uploadProviders.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { productionOutputDimensions } from "../dist/stages/resolutionPolicy.js";
import {
    composeUploadMetadata,
    productionUploadIdentity,
    uploadLookupIdentity,
} from "../dist/metadata/composeUploadMetadata.js";
import { ChromiumVideoHostUploader } from "../../../private/plugins/videohost/dist/chromiumVideoHostUploader.js";

test("pin: production geometry for the sizes not pinned in v4.test.mjs", () => {
    const size = (width, height, sampleAspectRatio) => productionOutputDimensions({ width, height, sampleAspectRatio });
    assert.deepEqual(size(1920, 1080, "1:1"), { width: 1920, height: 1080, rotate: false });
    assert.deepEqual(size(1920, 1080, null), { width: 1920, height: 1080, rotate: false });
    assert.deepEqual(size(1080, 1920, "1:1"), { width: 1920, height: 1080, rotate: true });
    // 4:3 square pixels: covers 1920x1080 by growing to 1440 tall, never cropped.
    assert.deepEqual(size(1440, 1080, "1:1"), { width: 1920, height: 1440, rotate: false });
    // Anamorphic 1440x1080 shown at 16:9.
    assert.deepEqual(size(1440, 1080, "4:3"), { width: 1920, height: 1080, rotate: false });
});

const recording = (provider, folder) => ({
    id: "c".repeat(64), provider, sourcePath: `/synthetic/${provider}/downloaded/${folder}`,
});
// Extra whitespace and descriptor tags are part of the fixture on purpose.
const description = { output: {
    title: "  Synthetic   person waves at the camera  ",
    description: "A synthetic   description.\nSecond line.",
    tags: ["ignored", "Also Ignored"],
} };

test("pin: full upload metadata (TsLive, with alias)", () => {
    assert.deepEqual(composeUploadMetadata(recording("tslive", "2026-03-04 050607 synthetic_alias"), description,
        { status: "resolved", streamerUrl: "https://ts-live.example/acct123", aliasUrl: "https://ts-live.example/synthetic_alias" }), {
        title: "Synthetic person waves at the camera [2026-03-04 050607 synthetic_alias]",
        description: "A synthetic description. Second line.\n\n"
            + "Recorded: 2026-03-04 05:06:07\nSource: https://ts-live.example/acct123\nAlias: https://ts-live.example/synthetic_alias",
        tags: ["tslive", "live"],
    });
});

test("pin: split part metadata (LADDER, no alias line)", () => {
    const ladder = recording("ladder", "2026-03-04 050607 10000001");
    const metadata = composeUploadMetadata(ladder, description,
        { status: "resolved", streamerUrl: "https://ladder-live.example/10000001/", aliasUrl: null }, "shape2");
    assert.deepEqual(metadata, {
        title: "Synthetic person waves at the camera [2026-03-04 050607 10000001 | part 2]",
        description: "A synthetic description. Second line.\n\nRecorded: 2026-03-04 05:06:07\nSource: https://ladder-live.example/10000001/",
        tags: ["ladder", "live"],
    });
    assert.equal(uploadLookupIdentity(ladder, "shape2", metadata.title), "2026-03-04 050607 10000001 | part 2");
});

test("pin: diagnostic (comparison trial) metadata (FMP4 tags as fmp4live)", () => {
    const fmp4 = recording("fmp4", "2026-03-04 050607 synthetic_room");
    const metadata = composeUploadMetadata(fmp4, description,
        { status: "resolved", streamerUrl: "https://fmp4-live.example/20000002", aliasUrl: "https://fmp4-live.example/synthetic_room" },
        "shape1", { diagnosticTitle: true });
    assert.deepEqual(metadata, {
        title: "Synthetic person waves at the camera [2026-03-04 050607 synthetic_room | production-v6 | shape1]",
        description: "A synthetic description. Second line.\n\n"
            + "Recorded: 2026-03-04 05:06:07\nSource: https://fmp4-live.example/20000002\nAlias: https://fmp4-live.example/synthetic_room",
        tags: ["fmp4live", "live"],
    });
    assert.equal(productionUploadIdentity(fmp4, "shape1"), "2026-03-04 050607 synthetic_room | production-v6 | shape1");
    assert.equal(uploadLookupIdentity(fmp4, "shape1", metadata.title), "2026-03-04 050607 synthetic_room | production-v6 | shape1");
});

test("pin: unresolved provenance placeholder, unknown time and legacy part names", () => {
    const fmp4 = recording("fmp4", "synthetic folder");
    assert.deepEqual(composeUploadMetadata(fmp4, description,
        { status: "review_required", reason: "identifier_not_resolved_by_server", streamerUrl: null, aliasUrl: null }), {
        title: "Synthetic person waves at the camera [synthetic folder]",
        description: "A synthetic description. Second line.\n\nRecorded: unknown\nSource: TODO LATER",
        tags: ["fmp4live", "live"],
    });
    // Parts from earlier policies have no public part suffix and no lookup identity.
    const tslive = recording("tslive", "2026-03-04 050607 synthetic_alias");
    const legacy = composeUploadMetadata(tslive, description,
        { status: "resolved", streamerUrl: "https://ts-live.example/acct123", aliasUrl: null }, "nonmax1080p");
    assert.equal(legacy.title, "Synthetic person waves at the camera [2026-03-04 050607 synthetic_alias]");
    assert.equal(uploadLookupIdentity(tslive, "nonmax1080p", legacy.title), null);
});

test("pin: shortening keeps the stamp and footer inside the 255/1000 limits", () => {
    const metadata = composeUploadMetadata(recording("tslive", "2026-03-04 050607 synthetic_alias"),
        { output: { title: "word ".repeat(80), description: "sentence ".repeat(200) } },
        { status: "resolved", streamerUrl: "https://ts-live.example/acct123", aliasUrl: null });
    assert.equal(metadata.title, `${"word ".repeat(43).trimEnd()}… [2026-03-04 050607 synthetic_alias]`);
    assert.equal(metadata.title.length, 251);
    assert.equal(metadata.description,
        `${"sentence ".repeat(103).trimEnd()}…\n\nRecorded: 2026-03-04 05:06:07\nSource: https://ts-live.example/acct123`);
    assert.equal(metadata.description.length, 991);
});

// The uploader recognizes its own uploads by the identity it reads from the
// title: the request's diagnostic identity when the title carries it, else the
// last bracket. Observed through upload() with the browser parts replaced.
test("pin: the identity the uploader looks for before uploading", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pins-uploader-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const artifactPath = path.join(root, "artifact.mp4");
    await writeFile(artifactPath, "synthetic");
    const uploader = new ChromiumVideoHostUploader({ executablePath: "unused", profilePath: "unused" });
    const looked = [];
    uploader.withAuthenticatedPage = async (action) => await action({});
    uploader.lookupUpload = async (_page, identity) => {
        looked.push(identity);
        return { kind: "found", remoteId: "1", remoteUrl: "https://destination.invalid/video/1/" };
    };
    const folder = "2026-03-04 050607 synthetic_alias";
    const diagnostic = `${folder} | production-v6 | full`;
    const identityFor = async (title, uploadIdentity = diagnostic) => {
        looked.length = 0;
        const outcome = await uploader.upload({ recordingId: "r", uploadIdentity, artifactPath, sizeBytes: 9, title,
            description: "d", tags: [], visibility: "public" });
        assert.deepEqual(outcome, { kind: "existing", remoteId: "1", remoteUrl: "https://destination.invalid/video/1/" });
        assert.equal(looked.length, 1);
        return looked[0];
    };
    assert.equal(await identityFor(`Synthetic title [${folder}]`), folder);
    assert.equal(await identityFor(`Synthetic title [${folder}]  `), folder);
    assert.equal(await identityFor(`Synthetic title [${folder} | part 2]`), `${folder} | part 2`);
    assert.equal(await identityFor(`Synthetic [note] title [${folder}]`), folder);
    assert.equal(await identityFor(`Synthetic title [${diagnostic}]`), diagnostic);
    assert.equal(await identityFor(`Synthetic title [${folder} | production-v6 | shape2]`, `${folder} | production-v6 | shape2`),
        `${folder} | production-v6 | shape2`);
    for (const title of [`Synthetic title ${folder}`, `Synthetic [${folder}] title`, "Synthetic title []"]) {
        looked.length = 0;
        await assert.rejects(uploader.upload({ recordingId: "r", uploadIdentity: diagnostic, artifactPath, sizeBytes: 9, title,
            description: "d", tags: [], visibility: "public" }), /lacks an exact filename identity/);
        assert.deepEqual(looked, [], "no lookup without an identity");
    }
});
