// The provider of a request that names none: the first capture site in the sites file.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const sandbox = await mkdtemp(path.join(tmpdir(), "default-provider-"));
process.env.HOME = path.join(sandbox, "home");
process.env.VIDEO_SERVICES_DATA_ROOT = path.join(sandbox, "data");
process.env.VIDEO_DOWNLOADS_ROOT = path.join(sandbox, "downloads");
test.after(() => rm(sandbox, { recursive: true, force: true }));

const { default: express } = await import("express");
const { configureProviders, getAllProviders } = await import("../dist/core/config.js");
const { default: videoRoutes } = await import("../dist/api/video.routes.js");
const { captureSiteIds } = await import("../dist/sites.js");

test("the capture sites, in the sites file's order, are the providers; the first is the default", async (t) => {
    const sites = [
        { id: "live-a", instance: { capture: {}, catalog: {} } },
        { id: "files", instance: { fileHost: {} } },
        { id: "live-b", instance: { capture: {} } },
    ];
    assert.deepEqual(captureSiteIds(sites), ["live-a", "live-b"]);
    configureProviders(captureSiteIds(sites));
    assert.deepEqual(getAllProviders(), ["live-a", "live-b"]);

    const app = express();
    app.use(express.json());
    app.use("/api", videoRoutes);
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;

    const repair = await fetch(`${base}/videos/missing/repair-playlist`, { method: "POST" });
    assert.equal(repair.status, 404);
    assert.deepEqual(await repair.json(), { success: false, error: "Video not found: missing (provider=live-a)" });
    const named = await fetch(`${base}/videos/missing/repair-playlist?provider=live-b`, { method: "POST" });
    assert.deepEqual(await named.json(), { success: false, error: "Video not found: missing (provider=live-b)" });
    const unknown = await fetch(`${base}/videos?provider=files`);
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: "Unknown provider: files" });
});
