// Pinning test: how a recording folder names its streamer. The folder name is read
// back by the server, the pipeline and the players.
//
// The real sites' list lines and token files are pinned with their plug-ins.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sandbox = await mkdtemp(path.join(os.tmpdir(), "pins-lists-"));
process.env.VIDEO_SERVICES_DATA_ROOT = path.join(sandbox, "data");
process.env.VIDEO_DOWNLOADS_ROOT = path.join(sandbox, "downloads");
test.after(() => rm(sandbox, { recursive: true, force: true }));

const { extractRecordingIdentifier } = await import("shared");
const { formatDownloadDirName } = await import("../dist/services/core/downloadUtils.js");

test("pin: folder name 'YYYY-MM-DD HHMMSS <alias>' (local time) and the identity read back from it", () => {
    const startedAt = new Date(2026, 2, 4, 5, 6, 7);
    for (const alias of ["synthetic_alias", "10000001", "synthetic c spaced"]) {
        const folder = formatDownloadDirName(alias, startedAt);
        assert.equal(folder, `2026-03-04 050607 ${alias}`);
        assert.equal(extractRecordingIdentifier(folder), alias);
    }
});
