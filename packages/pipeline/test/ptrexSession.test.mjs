import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { pipelineConfig } from "../dist/config.js";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { pinCookies, readPorntrexSession, sessionFingerprint, writePorntrexSession } from "../dist/upload/porntrexSession.js";
import { checkPorntrexSession } from "../dist/upload/porntrexKeepalive.js";
import { keepPorntrexSessionAlive } from "../dist/commands/runCampaignWorker.js";
import { connectPorntrexPhone } from "../dist/commands/connectPorntrexPhone.js";
import { porntrexSessionReport } from "../dist/commands/porntrexSessionReport.js";
import { PtrexPhone, phoneCookieScript } from "../dist/phone/ptrexPhone.js";

// Local fakes only: no porntrex, Mac or phone traffic.
const cookie = (name, value, extra = {}) => ({ name, value, domain: ".porntrex.com", path: "/", expires: -1,
    httpOnly: false, secure: false, sameSite: "Lax", ...extra });
const sessionCookies = [cookie("PHPSESSID", "a".repeat(32)), cookie("confirmed", "true", { domain: "www.porntrex.com", sameSite: "None" })];

async function root(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ptrex-session-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = { ...pipelineConfig, databasePath: path.join(directory, "pipeline.sqlite"),
        porntrexSessionPath: path.join(directory, "porntrex-session.json"), networkUploadsEnabled: true, uploadProvider: "porntrex",
        porntrexBrowserProfilePath: path.join(directory, "profile") };
    return { directory, config };
}

async function store(file, overrides = {}) {
    await writePorntrexSession(file, { version: 1, cookies: sessionCookies, passwordLoginAt: "2026-10-02T20:00:00.000Z",
        savedAt: "2026-10-02T20:00:00.000Z", ...overrides });
}

test("shared session file is private, pinned for 400 days and identified only by a fingerprint", async t => {
    const { config } = await root(t);
    await store(config.porntrexSessionPath);
    assert.equal((await stat(config.porntrexSessionPath)).mode & 0o777, 0o600);
    const session = await readPorntrexSession(config.porntrexSessionPath);
    assert.equal(session.cookies.length, 2);
    const now = new Date("2026-10-02T00:00:00Z");
    assert.equal(pinCookies(session.cookies, now)[0].expires, now.getTime() / 1000 + 400 * 86400);
    const fingerprint = sessionFingerprint(session.cookies);
    assert.match(fingerprint, /^[0-9a-f]{12}$/);
    assert(!"a".repeat(32).includes(fingerprint));
    await chmod(config.porntrexSessionPath, 0o644);
    await assert.rejects(readPorntrexSession(config.porntrexSessionPath), /private/);
    assert.equal(await readPorntrexSession(path.join(path.dirname(config.porntrexSessionPath), "missing.json")), null);
});

test("keep-alive sends only the shared session, never kt_member, and records rotation", async t => {
    const { config } = await root(t);
    await store(config.porntrexSessionPath);
    const seen = [];
    let mode = "in";
    const server = createServer((request, response) => {
        seen.push(request.headers.cookie);
        if (mode === "out") { response.writeHead(302, { location: "/" }); return response.end(); }
        if (mode === "rotate") response.setHeader("set-cookie", `PHPSESSID=${"b".repeat(32)}; path=/; domain=.porntrex.com`);
        response.end('<form><input type="file" name="content"></form>');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const ok = await checkPorntrexSession(config.porntrexSessionPath, fetch, origin);
    assert.equal(ok.loggedIn, true);
    assert.equal(seen[0], `PHPSESSID=${"a".repeat(32)}; confirmed=true`);
    mode = "out";
    const out = await checkPorntrexSession(config.porntrexSessionPath, fetch, origin);
    assert.deepEqual([out.loggedIn, out.note], [false, "redirected to /"]);
    mode = "rotate";
    const rotated = await checkPorntrexSession(config.porntrexSessionPath, fetch, origin);
    assert.match(rotated.note, /new PHP session ID/);
    assert.equal((await readPorntrexSession(config.porntrexSessionPath)).cookies[0].value, "b".repeat(32));
    assert(seen.every(header => !header.includes("kt_member")));
});

test("a logged-out keep-alive pauses the running campaign with the fix in its reason; resume clears it", async t => {
    const { config } = await root(t);
    const db = new PipelineDatabase(config.databasePath);
    t.after(() => db.close());
    db.setCampaignState("running");
    await keepPorntrexSessionAlive(config, new Date(), async () => ({ loggedIn: true, fingerprint: "f1", passwordLoginAt: null, note: "ok" }));
    assert.equal(db.getCampaignControl().state, "running");
    await keepPorntrexSessionAlive(config, new Date(), async () => ({ loggedIn: false, fingerprint: "f1", passwordLoginAt: null, note: "redirected to /" }));
    const control = db.getCampaignControl();
    assert.equal(control.state, "paused");
    assert.match(control.attentionReason, /redirected to \/.*ptrex:connect-iphone/);
    await keepPorntrexSessionAlive(config, new Date(), async () => { throw new Error("offline"); });
    assert.deepEqual(db.listProviderSessionEvents("porntrex").map(e => [e.kind, e.loggedIn]),
        [["keepalive", true], ["keepalive", false], ["keepalive_error", null]]);
    db.setCampaignState("running");
    assert.equal(db.getCampaignControl().attentionReason, null);
});

test("connect shares the pipeline session with the phone and resumes a campaign stopped for a lost session", async t => {
    const { config } = await root(t);
    const db = new PipelineDatabase(config.databasePath);
    t.after(() => db.close());
    db.pauseForAttention("Porntrex shared session is logged out; run `npm run ptrex:connect-iphone` to restore the shared session");
    let phoneCookies;
    const result = await connectPorntrexPhone(config, {
        openPipelineSession: async () => store(config.porntrexSessionPath, { passwordLoginAt: "2026-10-03T08:00:00.000Z" }),
        connectPhone: async cookies => { phoneCookies = cookies; return { loggedIn: true, host: "www.porntrex.com", finalPath: "/upload-video/" }; },
        checkSession: async () => ({ loggedIn: true, fingerprint: "x", passwordLoginAt: null, note: "ok" }),
        pause: async () => undefined, log: () => undefined,
    });
    assert.equal(result.campaign, "running");
    assert.equal(result.loggedInAgain, true);
    assert.deepEqual(phoneCookies.map(c => c.name), ["PHPSESSID", "confirmed"]);
    assert.deepEqual(db.listProviderSessionEvents("porntrex").map(e => e.kind), ["password_login", "phone_connected"]);

    db.pauseForAttention("manual hold");
    await assert.rejects(connectPorntrexPhone(config, {
        openPipelineSession: async () => undefined,
        connectPhone: async () => ({ loggedIn: false, host: "www.porntrex.com", finalPath: "/" }),
        checkSession: async () => ({ loggedIn: true, fingerprint: "x", passwordLoginAt: null, note: "ok" }),
        pause: async () => undefined, log: () => undefined,
    }), /phone not logged in.*stays paused/);
    assert.equal(db.getCampaignControl().state, "paused");
});

test("the phone script swaps in the shared session, drops kt_member and reports only booleans", async t => {
    const shared = "c".repeat(32);
    const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([{ ...cookie("PHPSESSID", "old"), expires: -1 }, { ...cookie("kt_member", "stale"), expires: Date.now() / 1000 + 9e5 }]);
    await context.route("https://www.porntrex.com/**", route => {
        const header = route.request().headers().cookie ?? "";
        const loggedIn = header.includes(`PHPSESSID=${shared}`) && !header.includes("kt_member");
        route.fulfill({ contentType: "text/html", body: loggedIn && route.request().url().includes("/upload-video/") ? '<input type="file" name="content">' : "<p>home</p>" });
    });
    const page = await context.newPage();
    await page.goto("https://www.porntrex.com/my/videos/");
    const script = phoneCookieScript([{ ...sessionCookies[0], value: shared }, sessionCookies[1]]);
    assert(!script.includes("stale"));
    const result = JSON.parse(await page.evaluate(script));
    assert.deepEqual(result, { loggedIn: true, host: "www.porntrex.com", finalPath: "/upload-video/" });
    const jar = Object.fromEntries((await context.cookies("https://www.porntrex.com")).map(c => [c.name, c]));
    assert.equal(jar.PHPSESSID.value, shared);
    assert(jar.PHPSESSID.expires > Date.now() / 1000 + 300 * 86400, "pinned so a restart keeps it");
    assert.equal(jar.kt_member, undefined);
});

test("phone bridge launches Ptrex, inspects, verifies after reload, cleans up, and explains a locked phone", async () => {
    const commands = [];
    const results = ['RESULT {"loggedIn":true,"host":"www.porntrex.com","finalPath":"/upload-video/"}'];
    const ssh = async (command, input) => {
        commands.push(command.split(" ")[0] === "cd" ? "inspect" : command.split(" ").slice(0, 4).join(" "));
        if (command.startsWith("cd ")) return { code: 0, stdout: `PAGE x\n${results[0]}\n`, stderr: "" };
        assert(!input || !input.includes("kt_member=" + "stale"));
        return { code: 0, stdout: "", stderr: "" };
    };
    const phone = new PtrexPhone(undefined, ssh, async () => undefined);
    assert.equal((await phone.connect(sessionCookies)).loggedIn, true);
    assert.deepEqual(commands.filter(c => c !== "inspect").map(c => c.split(" ")[0]), ["umask", "xcrun", "umask", "rm", "rm"]);
    assert.equal(commands.filter(c => c === "inspect").length, 2);
    const locked = new PtrexPhone(undefined, async command => command.startsWith("xcrun")
        ? { code: 1, stdout: "", stderr: "ERROR: The device is locked." } : { code: 0, stdout: "", stderr: "" }, async () => undefined);
    await assert.rejects(locked.connect(sessionCookies), /locked: unlock it/);
});

test("session report answers the 30-day question from the keep-alive record", async t => {
    const { config } = await root(t);
    await store(config.porntrexSessionPath, { passwordLoginAt: "2026-10-01T00:00:00.000Z" });
    const fingerprint = sessionFingerprint(sessionCookies);
    const db = new PipelineDatabase(config.databasePath);
    t.after(() => db.close());
    db.recordProviderSessionEvent({ provider: "porntrex", kind: "keepalive", loggedIn: true, fingerprint, note: "ok" }, new Date("2026-10-20T00:00:00Z"));
    assert.match((await porntrexSessionReport(config, new Date("2026-10-20T01:00:00Z"))).verdict, /^Logged in; 19 days/);
    db.recordProviderSessionEvent({ provider: "porntrex", kind: "keepalive", loggedIn: true, fingerprint, note: "ok" }, new Date("2026-11-03T00:00:00Z"));
    const later = await porntrexSessionReport(config, new Date("2026-11-03T01:00:00Z"));
    assert.match(later.verdict, /33 days.*does not end sessions at 30 days/);
    assert.equal(later.keepalive.checks, 2);
    assert(!JSON.stringify(later).includes("a".repeat(32)), "never reports the session value");
});
