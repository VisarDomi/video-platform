import assert from "node:assert/strict";
import test from "node:test";
import {
    combineAliasRefreshIds,
    parseTangoTargetIds,
} from "../dist/services/aliasRefreshService.js";

test("alias refresh includes unique tango.txt targets as well as followed accounts", () => {
    const targetIds = parseTangoTargetIds(`
        # targets
        https://tango.me/download-only stale-alias
        https://tango.me/shared current-alias
        https://tango.me/download-only duplicate
        invalid line
    `);

    assert.deepEqual(targetIds, ["download-only", "shared"]);
    assert.deepEqual(
        combineAliasRefreshIds(["followed-only", "shared"], targetIds),
        ["followed-only", "shared", "download-only"],
    );
});
