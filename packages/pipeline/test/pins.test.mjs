// Pinning tests: values production matches against what it converted before. The
// production geometry decides what every artifact looks like (a change re-encodes
// everything once the policy version is bumped). Change them only on purpose.
//
// Already pinned elsewhere, not repeated here:
//   RESOLUTION_POLICY_VERSION + ARTIFACT_RECIPE_VERSION: artifactCache.test.mjs
//     ("resolution-policy-v6: [artifact-recipe-v4] artifact cache hit"), shapeSplit.test.mjs
//   CURRENT_PRODUCTION_VERSION: pipelineDatabase.test.mjs, campaign.test.mjs
//   "-ccw" / "-shapeN" artifact names: shapeSplit.test.mjs (productionArtifactSuffix, isCounterclockwiseArtifact)
//   720x1280, 640x480, 1280x720 production sizes: v4.test.mjs
//   The title stamp and composed metadata: metadata.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { productionOutputDimensions } from "../dist/stages/resolutionPolicy.js";

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
