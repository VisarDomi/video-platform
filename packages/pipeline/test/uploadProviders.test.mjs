import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { assessFinalArtifact, policyForUploadProvider } from "shared";
import { readUploadProvidersFile, readProviderCredentials } from "../dist/config/uploadProviders.js";
import { readXvideosCredentials } from "../dist/config/secrets.js";
import { submitPasswordLogin } from "../dist/upload/passwordLogin.js";
import { ChromiumPorntrexUploader, matchesPorntrexIdentity, passPorntrexAgeGate } from "../dist/upload/chromiumPorntrexUploader.js";

test("provider-keyed private credentials only; a legacy activeProvider field is ignored; no secret diagnostics", async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "upload-provider-config-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "upload-providers.json");
    const data = { version: 1, providers: {
        xvideos: { email: "xv@example.invalid", password: "test-xv-only" },
        porntrex: { username: "px@example.invalid", password: "test-px-only" },
    } };
    await writeFile(file, JSON.stringify(data), { mode: 0o600 });
    assert.equal(readProviderCredentials(file, "porntrex").email, "px@example.invalid");
    assert.equal((await readXvideosCredentials(file)).email, "xv@example.invalid");
    data.activeProvider = ["not", "a", "provider"];
    await writeFile(file, JSON.stringify(data));
    assert.equal(readUploadProvidersFile(file).version, 1);
    await writeFile(file, "test-secret-invalid-json");
    assert.throws(() => readUploadProvidersFile(file), error => !error.message.includes("test-secret"));
    await chmod(file, 0o644);
    assert.throws(() => readUploadProvidersFile(file), /private file/);
});

test("Porntrex 10GB cap is inclusive and does not inherit XVideos duration or file cap", () => {
    const artifact = { id: "one", path: "/tmp/fixture.mp4", durationSeconds: 3 * 3600, sizeBytes: 10_000_000_000 };
    assert.equal(assessFinalArtifact(artifact, policyForUploadProvider("porntrex")).disposition, "ready_for_upload");
    const over = assessFinalArtifact({ ...artifact, sizeBytes: artifact.sizeBytes + 1 }, policyForUploadProvider("porntrex"));
    assert.equal(over.disposition, "blocked_too_large");
    assert.match(over.notification.message, /porntrex 10000000000-byte maximum/);
    assert.equal(assessFinalArtifact(artifact, policyForUploadProvider("xvideos")).disposition, "blocked_too_long");
    assert.equal(assessFinalArtifact({ ...artifact, durationSeconds: 600, sizeBytes: 11_000_000_000 }, policyForUploadProvider("xvideos")).disposition, "ready_for_upload");
});

test("native password login uses only its same-origin, unique form and never a social button", async t => {
    const server = createServer((_request, response) => response.end(`<!doctype html><form method="post"><input name="username"><input type="hidden" name="email_link"><input type="password" name="pass"><input type="submit" value="Log in"></form><button>Sign in with Google</button><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.submitted='true'}</script>`));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(origin);
    await submitPasswordLogin(page, origin, { email: "local@example.invalid", password: "fake-local-only" });
    assert.equal(await page.locator("body").getAttribute("data-submitted"), "true");
    await page.goto(origin);
    await page.locator("form").evaluate(form => form.action = "https://external.example.invalid/login");
    await assert.rejects(submitPasswordLogin(page, origin, { email: "x", password: "x" }), /unexpected origin/);
    assert.equal(await page.locator("input[name=username]").inputValue(), "");
    await page.goto(origin);
    await page.locator("form").evaluate(form => form.after(form.cloneNode(true)));
    await assert.rejects(submitPasswordLogin(page, origin, { email: "x", password: "x" }), /one visible/);
    await assert.rejects(submitPasswordLogin(page, "https://different.example.invalid", { email: "x", password: "x" }), /expected provider origin/);
});

test("native password login ignores hidden reset-password fields (XVideos sign-in form shape)", async t => {
    const server = createServer((_request, response) => response.end(`<!doctype html><form id="signin-form" method="post"><input type="hidden" name="signin-form[csrf_token]"><input type="email" name="signin-form[login]"><input type="password" name="signin-form[password]"><button type="button"></button><div hidden><input type="password" name="signin-form[new_password]" autocomplete="new-password"><input type="password" name="signin-form[new_password_confirm]" autocomplete="new-password"></div><input type="checkbox" name="signin-form[rememberme]"><button type="submit">Sign in</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);document.body.dataset.submitted=[f.get('signin-form[login]'),f.get('signin-form[password]'),f.get('signin-form[new_password]'),f.get('signin-form[rememberme]')].join('|')}</script>`));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(origin);
    await submitPasswordLogin(page, origin, { email: "local@example.invalid", password: "fake-local-only" });
    assert.equal(await page.locator("body").getAttribute("data-submitted"), "local@example.invalid|fake-local-only||on");
});

test("Porntrex 18+ gate is answered only through its exact confirm button; other overlays need a person", async t => {
    const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`<div id="overlay"><p>This is an adult website</p><div id="okButton">Im 18 or older</div><div>LEAVE</div></div><script>document.getElementById('okButton').onclick=()=>document.getElementById('overlay').style.display='none'</script>`);
    await passPorntrexAgeGate(page);
    assert.equal(await page.locator("#overlay").isVisible(), false);
    await passPorntrexAgeGate(page);
    await page.setContent(`<div id="overlay"><p>Verify your phone number</p><div id="okButton">Continue</div></div>`);
    await assert.rejects(passPorntrexAgeGate(page), /first-visit Porntrex prompts/);
});

test("native login ticks a styled-hidden remember-me box (Porntrex form shape)", async t => {
    const server = createServer((_request, response) => response.end(`<!doctype html><form method="post"><input type="text" name="username"><input type="password" name="pass"><input type="checkbox" name="remember_me" style="display:none"><input type="hidden" name="action" value="login"><input type="submit"></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.remember=String(new FormData(e.target).get('remember_me'))}</script>`));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(origin);
    await submitPasswordLogin(page, origin, { email: "local@example.invalid", password: "fake-local-only" });
    assert.equal(await page.locator("body").getAttribute("data-remember"), "on");
});

test("Porntrex exact filename identity recognizes manual titles, never approximate aliases", () => {
    const filename = "2026-07-13 162147 AI_channel";
    assert(matchesPorntrexIdentity(`Natural model title [${filename}]`, filename));
    assert(matchesPorntrexIdentity(`String panty ${filename}`, filename));
    assert(!matchesPorntrexIdentity(`String panty ${filename} extra`, filename));
    assert(!matchesPorntrexIdentity(`String panty 2026-07-13 162148 AI_channel`, filename));
});

test("Porntrex upload form contract is exercised against a local fixture only", async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "porntrex-form-fixture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const artifactPath = path.join(root, "fake.mp4");
    await writeFile(artifactPath, "local-fixture");
    const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    const metadataForm = `<form id="metadata"><p class="section-title">Video Info</p><input id="edit_video_title" name="title"><textarea id="edit_video_description"></textarea><input id="edit_video_tags"><div class="list-selector"><input id="edit_video_categories" readonly onclick="document.getElementById('popup').hidden=false"><input id="category_id" type="hidden" name="category_ids[]"><div id="popup" hidden><input type="checkbox" id="category_21" value="21" style="display:none" onchange="document.getElementById('category_id').value=this.checked?'21':''"><label for="category_21">Webcam</label></div></div><input type="submit" value="Save"></form>`;
    let requests = 0;
    await page.route("**/*", async route => {
        requests++;
        assert.equal(route.request().url(), "https://www.porntrex.com/upload-video/");
        await route.fulfill({ contentType: "text/html", body: `<!doctype html><form id="file"><input id="edit_video_upload_option_file" type="radio" checked><input type="file" name="content"><input type="submit" value="Continue..."></form><script>document.getElementById('file').onsubmit=e=>{e.preventDefault();document.body.innerHTML=${JSON.stringify(metadataForm)};document.getElementById('metadata').onsubmit=e=>{e.preventDefault();document.body.dataset.saved='true';};document.addEventListener('click',e=>{const p=document.getElementById('popup');if(p&&!p.contains(e.target)&&e.target.id!=='edit_video_categories')p.hidden=true})}</script>` });
    });
    const uploader = new ChromiumPorntrexUploader({ executablePath: "unused", profilePath: "unused", email: "fake", password: "fake" });
    uploader.withAuthenticatedPage = async action => action(page);
    let lookups = 0;
    uploader.lookupUpload = async () => {
        if (++lookups === 1) return { kind: "absent" };
        assert.equal(await page.locator("#edit_video_title").inputValue(), "Natural title [2026-07-13 162147 AI_channel]");
        assert.equal(await page.locator("#edit_video_description").inputValue(), "Exact saved description");
        assert.equal(await page.locator("#edit_video_tags").inputValue(), "stripchat, live");
        assert.equal(await page.locator("#category_id").inputValue(), "21");
        assert.equal(await page.locator("body").getAttribute("data-saved"), "true");
        return { kind: "found", remoteId: "12345", remoteUrl: "https://www.porntrex.com/video/12345/example" };
    };
    const progress = [];
    const outcome = await uploader.upload({ recordingId: "source-id", uploadIdentity: "diagnostic", artifactPath,
        sizeBytes: 13, title: "Natural title [2026-07-13 162147 AI_channel]", description: "Exact saved description",
        tags: ["stripchat", "live"], visibility: "public", onProgress: phase => progress.push(phase) });
    assert.equal(outcome.kind, "uploaded");
    assert.equal(outcome.receipt.submittedVideoId, "12345");
    assert.deepEqual(progress, ["file_uploading", "file_uploaded", "metadata_submitting"]);
    assert.equal(requests, 1, "all browser traffic was intercepted; no real upload occurred");
    await assert.rejects(uploader.upload({ sizeBytes: 10_000_000_001, visibility: "public" }), /blocked_too_large/);
});

test("Porntrex lookup counts a just-uploaded 'Processing...' row by ID and title, and still refuses malformed rows", async t => {
    const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    let rows = `<div class="video-item processing" data-item-id="3351302"><a class="thumb"></a><span class="line-processing">Processing...</span><p class="inf"><a href="" title="t">Alluring Woman [2025-10-02 141119 mmarianna]</a></p></div>`
        + `<div class="video-item" data-item-id="3314558"><a href="https://www.porntrex.com/video/3314558/x" class="thumb"></a><p class="inf"><a href="https://www.porntrex.com/video/3314558/x">String panty 2026-07-13 162147 AI_channel</a></p></div>`;
    await context.route("https://www.porntrex.com/**", route => route.fulfill({ contentType: "text/html",
        body: `<div id="list_videos_my_uploaded_videos"><h2>My Videos (1)</h2>${rows}</div>` }));
    const page = await context.newPage();
    const uploader = new ChromiumPorntrexUploader({ executablePath: "unused", profilePath: "unused", email: "fake", password: "fake" });
    assert.deepEqual(await uploader.lookupUpload(page, "2025-10-02 141119 mmarianna"),
        { kind: "found", remoteId: "3351302", title: "Alluring Woman [2025-10-02 141119 mmarianna]", remoteUrl: "https://www.porntrex.com/video/3351302/" });
    assert.equal((await uploader.lookupUpload(page, "2026-07-13 162147 AI_channel")).remoteId, "3314558");
    assert.equal((await uploader.lookupUpload(page, "2026-01-01 000000 nobody")).kind, "absent");
    rows += `<div class="video-item" data-item-id="9"><p class="inf"><a href="">Broken [x]</a></p></div>`;
    await assert.rejects(uploader.lookupUpload(page, "2026-01-01 000000 nobody"), /Incomplete Porntrex upload row/);
});
