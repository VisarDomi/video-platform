import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// The logger writes to the console; a child process captures one line.
function logLine(script) {
    return execFileSync(process.execPath, ["--input-type=module", "-e", `
        import { createLogger } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
        const logger = createLogger("test");
        ${script}
    `], { encoding: "utf8", env: { ...process.env, JOURNAL_STREAM: "" } });
}

test("an Error in the details keeps its message, code and cause", () => {
    const output = logLine(`
        const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
        logger.error("Failed to retrieve videos", { error: new TypeError("fetch failed", { cause }) });
    `);
    assert.match(output, /Failed to retrieve videos/);
    assert.match(output, /"name":"TypeError","message":"fetch failed"/);
    assert.match(output, /"cause":\{"name":"Error","message":"connect ECONNREFUSED 127\.0\.0\.1:443","code":"ECONNREFUSED"\}/);
});
