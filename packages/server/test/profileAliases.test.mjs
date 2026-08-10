import assert from "node:assert/strict";
import test from "node:test";
import { extractAliasSnapshot } from "../dist/services/tango/profileAliases.js";

test("Tango profile parsing keeps the first alias current and preserves the rest as history", () => {
    const snapshot = extractAliasSnapshot({
        aliases: [
            { alias: "bellabr1", created: 1771921906260 },
            { alias: "nutyipidoras", created: 1771595420766 },
            { alias: "bellabr", created: 1759605434865 },
        ],
    });

    assert.deepEqual(snapshot, {
        current: "bellabr1",
        history: ["nutyipidoras", "bellabr"],
    });
});
