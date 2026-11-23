// The phone-session route's production dependencies: the site's auth.provisionDevice
// through the registry, never the auth package's build output by path.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// The server's state folder is home-relative: keep it in a sandbox.
const sandbox = await mkdtemp(path.join(tmpdir(), "phone-session-site-"));
process.env.HOME = path.join(sandbox, "home");
process.env.VIDEO_SERVICES_DATA_ROOT = path.join(sandbox, "data");
const accounts = path.join(sandbox, "auth-accounts.json");
process.env.VIDEO_AUTH_ACCOUNTS_FILE = accounts;
test.after(() => rm(sandbox, { recursive: true, force: true }));

const { phoneSessionDependencies, phoneKeyPath } = await import("../dist/api/providers/phone-session.routes.js");

test("the phone signs in with the site's account, on the Xvfb display, and the handoff is the site's", async (t) => {
    const display = process.env.DISPLAY, browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
    t.after(() => {
        if (display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = display;
        if (browsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
    });
    const calls = [];
    const auth = {
        provisionDevice: async (account, requestId) => {
            calls.push(["provision", account.email, requestId, process.env.DISPLAY, process.env.PLAYWRIGHT_BROWSERS_PATH]);
            return { cookies: [{ name: "fixture" }] };
        },
        acknowledgeDevice: async (requestId) => { calls.push(["acknowledge", requestId]); },
    };
    const site = { id: "live-a", label: "Live A" };
    const dependencies = phoneSessionDependencies(site, auth, "live-a");
    assert.equal(dependencies.available(), false, "no accounts file: this PC cannot sign in");

    await writeFile(accounts, JSON.stringify({ accounts: [
        { email: "other@example.invalid", password: "x", provider: "live-b" },
        { email: "phone@example.invalid", password: "x" },
    ] }));
    assert.equal(dependencies.available(), true);
    delete process.env.DISPLAY;
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    assert.deepEqual(await dependencies.login("fixture-request-12345678"), { cookies: [{ name: "fixture" }] });
    // The sign-in never points Playwright at the browsers it downloads (it sets no
    // PLAYWRIGHT_BROWSERS_PATH); the site launches the system's Chromium.
    assert.deepEqual(calls, [["provision", "phone@example.invalid", "fixture-request-12345678", ":111", undefined]]);

    // The receipt of a handoff, kept until the phone acknowledges it.
    dependencies.retain("fixture-request-12345678", { cookies: [] });
    const receipt = path.join(sandbox, "home", ".local", "share", "video-services", "live-a-phone-handoff.json");
    assert.equal(JSON.parse(await readFile(receipt, "utf8")).id, "fixture-request-12345678");
    assert.deepEqual(dependencies.retained("fixture-request-12345678"), { cookies: [] });
    await dependencies.acknowledge("fixture-request-12345678");
    assert.deepEqual(calls.at(-1), ["acknowledge", "fixture-request-12345678"]);
    assert.equal(existsSync(receipt), false);

    assert.equal(phoneKeyPath(site), path.join(sandbox, "home", ".local", "share", "video-services", "live-a-phone-key"));
    assert.match(dependencies.key(), /^[0-9a-f]{64}$/);

    const unknown = phoneSessionDependencies({ id: "live-c", label: "Live C" }, auth, "live-a");
    await assert.rejects(unknown.login("fixture-request-87654321"), /No Live C account is configured/);
});
