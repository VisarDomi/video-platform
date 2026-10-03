import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pipelineConfig } from "../dist/config.js";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { comparePorntrexMetadata, parsePorntrexEditPage, parsePorntrexUploadsList, swappedWords } from "../dist/upload/porntrexMetadata.js";
import { notifyDesktop, stepNotification } from "../dist/notify.js";
import { porntrexUploadsReport } from "../dist/commands/porntrexUploadsReport.js";
import { writePorntrexSession } from "../dist/upload/porntrexSession.js";
import { composeUploadMetadata } from "../dist/metadata/composeUploadMetadata.js";
import { reconcileDueUploads } from "../dist/commands/reconcileUploads.js";

// Markup shapes copied from the live site (2026-10-02), values invented.
const editPage = (title, description, tags, categories, ids) => `<form><input type="text" name="title" id="edit_video_title" class="textfield" value="${title}" maxlength="300" />
<textarea name="description" id="edit_video_description" class="textarea" rows="3" placeholder="" >${description}</textarea>
<input type="text" name="tags" id="edit_video_tags" class="textfield" value="${tags}" placeholder="tags" />
<input type="text" id="edit_video_categories" class="textfield" value="${categories}" readonly/>${ids.map(id => `<input type="hidden" name="category_ids[]" value="${id}">`).join("")}</form>`;

test("stored Porntrex metadata parses from the edit page; site-added tags are fine, missing ours or Webcam are not", () => {
    const stored = parsePorntrexEditPage(editPage("A &amp; B [2025-10-02 183803 kaaysi]", "Line one.\nSource: x", "tango, live, A, B, 2025", "Webcam", ["21"]));
    assert.deepEqual(stored, { title: "A & B [2025-10-02 183803 kaaysi]", description: "Line one.\nSource: x", tags: ["tango", "live", "A", "B", "2025"], categories: ["Webcam"], categoryIds: ["21"] });
    const expected = { title: "A & B [2025-10-02 183803 kaaysi]", description: "Line one.\nSource: x", tags: ["Tango", "live"] };
    assert.deepEqual(comparePorntrexMetadata(expected, stored), { ok: true, problems: [] });
    const wrong = parsePorntrexEditPage(editPage("Other", "Changed", "live", "Asian", ["6"]));
    assert.deepEqual(comparePorntrexMetadata(expected, wrong).problems, ["title differs", 'description differs: "Line one.\nSource: x" became "Changed"', "missing tags: Tango", "Webcam category missing (has: Asian)"]);
    const swapped = { ...stored, description: "A white ruffled flowers and a bra." };
    assert.deepEqual(comparePorntrexMetadata({ ...expected, description: "A white ruffled choker and a bra." }, swapped).problems,
        ['description differs: "choker" became "flowers"']);
    assert.equal(parsePorntrexEditPage("<p>404</p>"), null);
});

test("My Videos rows parse with their processing state", () => {
    const html = `<div class="video-preview-screen video-item thumb-item processing" data-item-id="3351303"><a class="thumb rotator-screen" ></a><span class="line-processing">Processing...</span><p class="inf"><a href="" title="t" >New [2025-10-02 183803 kaaysi]</a></p></div>`
        + `<div class="video-preview-screen video-item thumb-item " data-item-id="3314558"><a href="https://www.porntrex.com/video/3314558/x" class="thumb"></a><p class="inf"><a href="https://www.porntrex.com/video/3314558/x" title="o">Old title</a></p></div>`;
    assert.deepEqual(parsePorntrexUploadsList(html), [
        { remoteId: "3351303", title: "New [2025-10-02 183803 kaaysi]", processing: true },
        { remoteId: "3314558", title: "Old title", processing: false },
    ]);
});

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "ptrex-uploads-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = { ...pipelineConfig, databasePath: path.join(root, "p.sqlite"), porntrexSessionPath: path.join(root, "s.json"), networkUploadsEnabled: true, cleanupEnabled: false };
    await writePorntrexSession(config.porntrexSessionPath, { version: 1, passwordLoginAt: "2026-10-02T20:00:00.000Z", savedAt: "2026-10-02T20:00:00.000Z",
        cookies: [{ name: "PHPSESSID", value: "a".repeat(32), domain: ".porntrex.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }] });
    const db = new PipelineDatabase(config.databasePath);
    t.after(() => db.close());
    const r = db.discover({ provider: "tango", sourceKind: "edited", sourcePath: path.join(root, "2025-10-02 183803 kaaysi"),
        playlistPath: path.join(root, "playlist.m3u8"), sourceFingerprint: "f", durationSeconds: 600 });
    db.transition(r.id, "server_ready", "remuxed");
    db.saveArtifact(r.id, { path: path.join(root, "a.mp4"), sizeBytes: 100, sha256: "a".repeat(64), validatedAt: "2026-10-02T20:00:00.000Z" });
    db.saveDescription(r.id, { artifactSha256: "a".repeat(64), promptVersion: "p", fps: 1, output: { title: "Black set", description: "A woman." }, evidencePath: path.join(root, "e.json") });
    db.saveProvenance(r.id, { observedIdentifier: "kaaysi", status: "resolved", streamerId: "1", alias: "kaaysi", streamerUrl: "https://tango.me/1", aliasUrl: null, reason: null, updatedAt: "2026-10-02T20:00:00.000Z" });
    const metadata = composeUploadMetadata(r, db.getDescription(r.id), db.getProvenance(r.id));
    db.saveUploadMetadata(r.id, metadata);
    const start = new Date("2026-10-02T20:52:00.000Z");
    const reservation = db.reserveUpload(r.id, 120, start, "Europe/Tirane", 600_000_000_000, "porntrex");
    const attempt = db.beginUpload(r.id, reservation, start, "porntrex");
    db.updateUploadProgress(attempt, "metadata_submitting", 100, start);
    db.finishUploadAttempt(attempt, { status: "uncertain", transmittedBytes: 100, remoteId: "3351303", confirmation: { confirmAfter: new Date(start.getTime() + 864e5) } }, start);
    return { config, db, r, metadata, attempt, start };
}

test("uploads report shows processing, then published with the stored metadata compared", async t => {
    const { config, metadata } = await fixture(t);
    let published = false;
    const get = async (_file, pathname) => {
        if (pathname === "/my/videos/") return { status: 200, location: null, html: `<div class="video-item${published ? "" : " processing"}" data-item-id="3351303"><p class="inf"><a href="">${metadata.title}</a></p></div>` };
        return published ? { status: 200, location: null, html: editPage(metadata.title, metadata.description, `${metadata.tags.join(", ")}, extra`, "Webcam", ["21"]) }
            : { status: 404, location: null, html: "" };
    };
    const first = await porntrexUploadsReport(config, 25, new Date("2026-10-02T21:52:00.000Z"), get);
    assert.deepEqual([first.summary.processing, first.summary.published, first.uploads[0].porntrex, first.uploads[0].titleListed, first.uploads[0].uploadedHoursAgo], [1, 0, "processing", true, 1]);
    published = true;
    const later = await porntrexUploadsReport(config, 25, new Date("2026-10-03T21:00:00.000Z"), get);
    assert.equal(later.uploads[0].porntrex, "published");
    assert.deepEqual(later.uploads[0].metadata, { ok: true, problems: [] });
    assert.equal(later.summary.metadataOk, 1);
    await assert.rejects(porntrexUploadsReport(config, 25, new Date(), async () => ({ status: 302, location: "/", html: "" })), /not logged in/);
});

test("a video Porntrex is still processing is re-checked in two hours, not a day", async t => {
    const { config, db, r, start } = await fixture(t);
    const due = new Date(start.getTime() + 864e5 + 1000);
    await reconcileDueUploads(config, due, { withAuthenticatedPage: async run => run({}),
        probeUploadStatus: async () => ({ outcome: "not_ready", remoteUrl: null, reason: "Porntrex is still processing the video", processing: true }) });
    assert.equal(db.get(r.id).state, "xvideos_uncertain");
    assert.equal(db.dueUploadConfirmations(new Date(due.getTime() + 2 * 36e5 - 1000)).length, 0);
    assert.equal(db.dueUploadConfirmations(new Date(due.getTime() + 2 * 36e5 + 1000)).length, 1);
});

test("words Porntrex swapped are learned only from tight, word-for-word changes", () => {
    assert.deepEqual(swappedWords("A white ruffled choker and a bra.", "A white ruffled flowers and a bra."), ["choker"]);
    assert.deepEqual(swappedWords("Choker, lace and BREATHING.", "flowers, lace and smiling."), ["choker", "breathing"]);
    assert.deepEqual(swappedWords("Same text here.", "same text here"), [], "case and punctuation are not swaps");
    assert.deepEqual(swappedWords("one two three four five six", "uno dos tres cuatro cinco seis"), [], "a rewrite teaches nothing");
    assert.deepEqual(swappedWords("Long description that porntrex cut short", "Long description that"), [], "truncation teaches nothing");
    assert.deepEqual(swappedWords("a red choker here", "a red here"), ["choker"]);
});

test("notifications: which steps alert, and only from the managed worker", () => {
    assert.equal(stepNotification({ disposition: "upload_completed" }), null);
    assert.equal(stepNotification({ disposition: "upload_retry_cooldown", reason: "list incomplete", resumeAt: "x" }).title, "Pipeline in a cooldown");
    assert.equal(stepNotification({ disposition: "attention_required", reason: "session lost" }).urgent, true);
    assert.equal(notifyDesktop("t", "b"), false, "tests never pop desktop notifications");
});
