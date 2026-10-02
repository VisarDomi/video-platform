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
import { activeUploadProvider } from "../dist/config.js";
import { submitPasswordLogin } from "../dist/upload/passwordLogin.js";
import { ChromiumPorntrexUploader, matchesPorntrexIdentity } from "../dist/upload/chromiumPorntrexUploader.js";
import { checkXvideosBeforePorntrex } from "../dist/upload/crossProviderIdentityGuard.js";

test("one active destination and provider-keyed private credentials; no secret diagnostics", async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "upload-provider-config-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "upload-providers.json");
    const data = { version: 1, activeProvider: "porntrex", providers: {
        xvideos: { email: "xv@example.invalid", password: "test-xv-only" },
        porntrex: { username: "px@example.invalid", password: "test-px-only" },
    } };
    await writeFile(file, JSON.stringify(data), { mode: 0o600 });
    assert.equal(activeUploadProvider({ credentialsFilePath: file }), "porntrex");
    assert.equal(readProviderCredentials(file, "porntrex").email, "px@example.invalid");
    assert.equal((await readXvideosCredentials(file)).email, "xv@example.invalid");
    data.activeProvider = "xvideos";
    await writeFile(file, JSON.stringify(data));
    assert.equal(activeUploadProvider({ credentialsFilePath: file }), "xvideos");
    data.activeProvider = ["xvideos", "porntrex"];
    await writeFile(file, JSON.stringify(data));
    assert.throws(() => readUploadProvidersFile(file), /must be xvideos or porntrex/);
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

test("Porntrex exact filename identity recognizes manual titles, never approximate aliases", () => {
    const filename = "2026-07-13 162147 AI_channel";
    assert(matchesPorntrexIdentity(`Natural model title [${filename}]`, filename));
    assert(matchesPorntrexIdentity(`String panty ${filename}`, filename));
    assert(!matchesPorntrexIdentity(`String panty ${filename} extra`, filename));
    assert(!matchesPorntrexIdentity(`String panty 2026-07-13 162148 AI_channel`, filename));
});

test("out-of-ledger XVideos matches are pinned and skipped before any Porntrex transfer", async () => {
    const parked = [];
    const database = { parkUploadedCopy: (...args) => parked.push(args) };
    const factory = async (_config, provider) => {
        assert.equal(provider, "xvideos");
        return { findUploadedCopy: async identity => {
            assert.equal(identity, "exact filename");
            return { kind: "found", remoteId: "12345", remoteUrl: "https://www.xvideos.com/video.example" };
        } };
    };
    const result = await checkXvideosBeforePorntrex(database, "source-id", "exact filename", {}, factory);
    assert.equal(result.disposition, "skipped_existing_xvideos");
    assert.equal(parked.length, 1);
    assert.equal(parked[0][4], "xvideos");
});

test("unknown cross-provider lookup is not absence and cannot authorize Porntrex upload", async () => {
    const database = { parkUploadedCopy: () => assert.fail("must not park an unknown identity") };
    for (const kind of ["title_mismatch", "ambiguous"]) await assert.rejects(
        checkXvideosBeforePorntrex(database, "source-id", "exact filename", {}, async () => ({ findUploadedCopy: async () => ({ kind }) })), /Ambiguous/);
    await assert.rejects(checkXvideosBeforePorntrex(database, "source-id", "exact filename", {}, async () => {
        throw Error("login unavailable");
    }), /login unavailable/);
    assert.equal(await checkXvideosBeforePorntrex(database, "source-id", "exact filename", {}, async () => ({
        findUploadedCopy: async () => ({ kind: "not_found" }),
    })), null);
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
    const metadataForm = `<form id="metadata"><input id="edit_video_title" name="title"><textarea id="edit_video_description"></textarea><input id="edit_video_tags"><input id="edit_video_categories" readonly onclick="document.getElementById('category').hidden=false"><label id="category" hidden><input type="checkbox" value="21" onchange="document.getElementById('category_id').value=this.checked?'21':''">Webcam</label><input id="category_id" type="hidden" name="category_ids[]"><input type="submit" value="Save"></form>`;
    let requests = 0;
    await page.route("**/*", async route => {
        requests++;
        assert.equal(route.request().url(), "https://www.porntrex.com/upload-video/");
        await route.fulfill({ contentType: "text/html", body: `<!doctype html><form id="file"><input id="edit_video_upload_option_file" type="radio" checked><input type="file" name="content"><input type="submit" value="Continue..."></form><script>document.getElementById('file').onsubmit=e=>{e.preventDefault();document.body.innerHTML=${JSON.stringify(metadataForm)};document.getElementById('metadata').onsubmit=e=>{e.preventDefault();document.body.dataset.saved='true';}}</script>` });
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
