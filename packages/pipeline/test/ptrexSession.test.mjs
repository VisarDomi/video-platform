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
import { PtrexPhone, phoneSessionInbox } from "../dist/phone/ptrexPhone.js";

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

test("the phone's inbox carries the shared session, never kt_member, named by an ID", () => {
    const inbox = JSON.parse(phoneSessionInbox([...sessionCookies, cookie("kt_member", "stale")], "id-1"));
    assert.equal(inbox.id, "id-1");
    assert.deepEqual(inbox.cookies.map(c => c.name), sessionCookies.map(c => c.name));
    assert(!JSON.stringify(inbox).includes("stale"));
    assert.deepEqual(Object.keys(inbox.cookies[0]).sort(), ["domain", "httpOnly", "name", "path", "secure", "value"]);
});

test("phone bridge copies the session into Video Vault, relaunches it, reads its answer, cleans up, and explains a locked phone", async () => {
    const commands = [];
    let id = "";
    const ssh = async (command, input) => {
        commands.push(command.startsWith("rm -f '/tmp/ptrex-result") ? "read" : command.startsWith("rm -f") ? command : command.split(" ").slice(0, 5).join(" "));
        if (input) id = JSON.parse(input).id;
        if (command.includes("device copy from")) return { code: 0, stdout: JSON.stringify({ id, loggedIn: true, finalPath: "/upload-video/" }), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
    };
    const phone = new PtrexPhone(undefined, ssh, async () => undefined);
    assert.deepEqual(await phone.connect(sessionCookies), { loggedIn: true, host: "www.porntrex.com", finalPath: "/upload-video/" });
    assert.deepEqual(commands.slice(0, 4), ["umask 077 && cat >", "xcrun devicectl device copy to",
        "xcrun devicectl device process launch", "read"]);
    assert.equal(commands.at(-1), `rm -f '/tmp/ptrex-session-${id}.json' '/tmp/ptrex-result-${id}.json'`);
    const stale = new PtrexPhone(undefined, async (command, input) => command.includes("copy from")
        ? { code: 0, stdout: JSON.stringify({ id: "older", loggedIn: true }), stderr: "" } : { code: 0, stdout: "", stderr: "" }, async () => undefined);
    await assert.rejects(stale.connect(sessionCookies), /did not answer/);
    const locked = new PtrexPhone(undefined, async command => command.includes("device copy to")
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
