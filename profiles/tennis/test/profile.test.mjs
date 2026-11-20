import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SDK_VERSION } from "sdk";
import { profile } from "../dist/index.js";

const facts = { siteId: "live-a", folderName: "2026-06-01 080000 court-one", recordedAt: "2026-06-01 08:00:00",
    sourceUrl: "https://live-a.example/court-one", aliasUrl: null };

test("the profile targets this SDK and describes tennis", async () => {
    assert.equal(profile.sdkVersion, SDK_VERSION);
    const created = profile.create();
    assert.equal(created.id, "tennis");
    assert.match(await readFile(created.descriptor.promptFile, "utf8"), /tennis match/);
});

test("footer: when, where from, and the alias page when there is one", () => {
    const { descriptionFooter } = profile.create();
    assert.equal(descriptionFooter(facts), "Recorded: 2026-06-01 08:00:00\nSource: https://live-a.example/court-one");
    assert.equal(descriptionFooter({ ...facts, recordedAt: "unknown", sourceUrl: null, aliasUrl: "https://live-a.example/centre" }),
        "Recorded: unknown\nSource: unknown\nAlias: https://live-a.example/centre");
});

test("tags: the site and the sport", () => {
    assert.deepEqual(profile.create().tags(facts), ["live-a", "tennis"]);
});
