import assert from "node:assert/strict";
import test from "node:test";

import { isRejectedTangoResolution } from "../dist/services/tango/api/apiClient.js";

test("Tango rejects 360p segments in either orientation", () => {
    assert.equal(isRejectedTangoResolution(360, 640), true);
    assert.equal(isRejectedTangoResolution(640, 360), true);
    assert.equal(isRejectedTangoResolution(720, 1280), false);
    assert.equal(isRejectedTangoResolution(1280, 720), false);
});
