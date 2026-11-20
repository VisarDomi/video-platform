import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createSitesRoutes } from "../dist/api/sites.routes.js";

test("GET /api/sites lists the capture sites in order, with labels and whether each has a list", async (t) => {
    const app = express();
    const sites = [{ id: "live-a", label: "Live A", list: true }, { id: "live-c", label: "Live C", list: false }];
    app.use(createSitesRoutes(sites));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.once("listening", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sites`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await response.json(), { sites });
});
