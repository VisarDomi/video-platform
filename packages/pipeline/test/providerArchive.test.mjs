import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { descriptionPrompt, descriptionPromptVersion } from "descriptor";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { pipelineConfig, activeUploadProvider } from "../dist/config.js";
import { reconcileDueUploads } from "../dist/commands/reconcileUploads.js";
import { inventoryRecordingId, syncXvideosInventory } from "../dist/commands/syncProviderInventory.js";
import { composeUploadMetadata } from "../dist/metadata/composeUploadMetadata.js";
import { checkRejectedPhrases, settleRejectedPhrases } from "../dist/metadata/rejectedPhraseCheck.js";
import { UploadCoordinator } from "../dist/upload/uploadCoordinator.js";
import { MetadataRejectedError, TransferAbortedBeforeSubmissionError, containedPhrases, rejectedPhrases } from "../dist/upload/providerWarnings.js";

// Generated databases only; never the live ledger or a provider account.
const start = new Date("2026-09-20T08:23:10.171Z");
const day = n => new Date(start.getTime() + n * 86400000);

async function fixture(t, { pending = true, description = "Purple ambient lighting in a bedroom", promptVersion = "test" } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-provider-archive-"));
    const config = { ...pipelineConfig, databasePath: path.join(root, "pipeline.sqlite"), networkUploadsEnabled: true, cleanupEnabled: false };
    const db = new PipelineDatabase(config.databasePath);
    t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
    const r = db.discover({ provider: "tango", sourceKind: "edited", sourcePath: path.join(root, "2025-10-16 015701 example"),
        playlistPath: path.join(root, "playlist.m3u8"), sourceFingerprint: "fingerprint", durationSeconds: 600 });
    db.transition(r.id, "server_ready", "remuxed");
    db.saveArtifact(r.id, { path: path.join(root, "artifact.mp4"), sizeBytes: 100, sha256: "a".repeat(64), validatedAt: start.toISOString() });
    db.saveDescription(r.id, { artifactSha256: "a".repeat(64), promptVersion, fps: 1,
        output: { title: "Natural model title", description }, evidencePath: path.join(root, "evidence.json") });
    db.saveProvenance(r.id, { observedIdentifier: "example", status: "resolved", streamerId: "123", alias: "example",
        streamerUrl: "https://tango.me/123", aliasUrl: null, reason: null, updatedAt: start.toISOString() });
    db.saveUploadMetadata(r.id, composeUploadMetadata(r, db.getDescription(r.id), db.getProvenance(r.id)));
    if (!pending) return { db, config, root, r };
    const reservation = db.reserveUpload(r.id, 120, start);
    const attempt = db.beginUpload(r.id, reservation, start);
    db.updateUploadProgress(attempt, "metadata_submitting", 100, start);
    db.finishUploadAttempt(attempt, { status: "uncertain", transmittedBytes: 100, confirmation: { confirmAfter: day(1) } }, start);
    return { db, config, root, r, attempt };
}

test("rejected phrases parse from provider text and match as substrings, like the provider", () => {
    assert.deepEqual(rejectedPhrases("x Sorry, 'Ambien' is not allowed here. y Sorry, 'rolling on' is not allowed here."), ["ambien", "rolling on"]);
    assert.deepEqual(containedPhrases(["Purple AMBIENT glow", "scrolling on her phone"], ["ambien", "rolling on", "breath"]),
        ["ambien", "rolling on"]);
});

test("prompt append is absent without phrases, deterministic with them, and part of the prompt version", async () => {
    assert.equal(descriptionPrompt("Base prompt.\n"), "Base prompt.\n");
    const appended = descriptionPrompt("Base prompt.\n", ["Waisted", "ambien", "ambien"]);
    assert.match(appended, /^Base prompt\.\n\nNever write any of these phrases .* "ambien", "waisted"\. /);
    assert.equal(appended, descriptionPrompt("Base prompt.\n", ["ambien", "waisted"]));
    assert.notEqual(await descriptionPromptVersion([]), await descriptionPromptVersion(["ambien"]));
    assert.equal(await descriptionPromptVersion(["b", "a"]), await descriptionPromptVersion(["a", "b"]));
});

test("local sanity check re-describes stale metadata once, then blocks instead of sending bytes", async t => {
    const stale = await fixture(t, { pending: false });
    assert.equal((await checkRejectedPhrases(stale.db, stale.r.id, "xvideos")).kind, "clean");
    stale.db.recordRejectedPhrases("xvideos", ["ambien"], null);
    assert.equal((await checkRejectedPhrases(stale.db, stale.r.id, "porntrex")).kind, "clean", "phrases are provider-specific");
    const verdict = await settleRejectedPhrases(stale.db, stale.r.id, "xvideos", new Date(), null);
    assert.deepEqual(verdict, { kind: "stale_description", phrases: ["ambien"] });
    assert.equal(stale.db.get(stale.r.id).state, "artifact_valid");

    const current = await fixture(t, { pending: false, promptVersion: await descriptionPromptVersion(["ambien"]) });
    current.db.recordRejectedPhrases("xvideos", ["ambien"], null);
    assert.equal((await settleRejectedPhrases(current.db, current.r.id, "xvideos", new Date(), null)).kind, "manual_review");
    assert.equal(current.db.get(current.r.id).state, "blocked");
    assert.match(current.db.get(current.r.id).blockReason, /'ambien'.*manual review/);
});

test("old rows that stored word rejections as limited visibility are split and learned on open", async t => {
    const { config, r, attempt } = await fixture(t);
    const raw = new DatabaseSync(config.databasePath);
    raw.prepare("UPDATE upload_attempts SET limited_visibility = ?, metadata_rejection = NULL WHERE id = ?")
        .run("Sorry, 'waisted' is not allowed here.", attempt);
    raw.close();
    const reopened = new PipelineDatabase(config.databasePath);
    t.after(() => reopened.close());
    const diagnostics = reopened.latestUploadDiagnostics(r.id);
    assert.equal(diagnostics.limited_visibility, null);
    assert.equal(diagnostics.metadata_rejection, "waisted");
    assert.deepEqual(reopened.listRejectedPhrases(), ["waisted"]);
});

test("a provider word rejection fails definitively, keeps byte accounting and stays upload-ready for a rewrite", async t => {
    const { db, r } = await fixture(t, { pending: false });
    const reservation = db.reserveUpload(r.id, 120, start);
    const uploader = { provider: "xvideos", upload: async request => {
        await request.onProgress("file_uploading", 100);
        await request.onProgress("metadata_submitting", 100);
        throw new MetadataRejectedError(["ambien"]);
    } };
    await assert.rejects(new UploadCoordinator(db, uploader).uploadAdmitted(r.id, reservation, {
        recordingId: r.id, uploadIdentity: r.id, artifactPath: "/unused", sizeBytes: 100, title: "t", description: "d",
        tags: [], visibility: "private" }, start), MetadataRejectedError);
    assert.equal(db.get(r.id).state, "metadata_ready");
    assert.deepEqual(db.listRejectedPhrases("xvideos"), ["ambien"]);
    assert.equal(db.dueUploadConfirmations(day(30)).length, 0, "nothing to reconcile: no remote video exists");
    assert.equal(db.uploadUsage("2026-09").spent, 100);
    assert.equal(db.canAttemptUpload(r.id, day(0.01)), true, "a definitive refusal does not hold the weekly slot");
});

test("a transfer that stops before the provider's metadata form is a plain failure, not a week-long uncertainty", async t => {
    const { db, r } = await fixture(t, { pending: false });
    const reservation = db.reserveUpload(r.id, 120, start, "Europe/Tirane", 600_000_000_000, "porntrex");
    const uploader = { provider: "porntrex", upload: async request => {
        await request.onProgress("file_uploading", 100);
        throw new TransferAbortedBeforeSubmissionError("Porntrex file transfer made no progress for 10 minutes (last 18%)");
    } };
    await assert.rejects(new UploadCoordinator(db, uploader).uploadAdmitted(r.id, reservation, {
        recordingId: r.id, uploadIdentity: r.id, artifactPath: "/unused", sizeBytes: 100, title: "t", description: "d",
        tags: [], visibility: "public" }, start), TransferAbortedBeforeSubmissionError);
    assert.equal(db.get(r.id).state, "metadata_ready");
    assert.equal(db.dueUploadConfirmations(day(30)).length, 0);
    assert.equal(db.canAttemptUpload(r.id, day(0.01)), true);
    assert.equal(db.uploadUsage("2026-09").spent, 100, "bytes still count against the monthly cap");
});

test("a video that had an ID and is now 404 was removed by the provider: blocked for review, never re-uploaded alone", async t => {
    const { db, config, r, attempt } = await fixture(t);
    db.attachUncertainRemote(attempt, "3351531");
    const probed = [];
    const browser = { withAuthenticatedPage: async run => run({}),
        lookupUpload: async () => assert.fail("no filename lookup: the ID was real"),
        probeUploadStatus: async (_page, id) => { probed.push(id); return { outcome: "missing", remoteUrl: null, reason: "404 and unlisted" }; } };
    await reconcileDueUploads(config, day(2), browser);
    assert.deepEqual(probed, ["3351531"]);
    const recording = db.get(r.id);
    assert.equal(recording.state, "blocked");
    assert.match(recording.blockReason, /removed video 3351531 after upload.*npm run retry/);
    assert.equal(db.dueUploadConfirmations(day(30)).length, 0);
    // A deliberate retry re-uploads at once: nothing exists to duplicate.
    db.retryBlocked(r.id, day(2));
    assert.equal(db.get(r.id).state, "metadata_ready");
    assert.equal(db.canAttemptUpload(r.id, day(2)), true);
});

test("inventory titles map to recording IDs only through an exact folder-name suffix", () => {
    assert.equal(inventoryRecordingId("Nice title [2026-01-20 140639 kylllllllie]"), "2026-01-20 140639 kylllllllie");
    assert.equal(inventoryRecordingId("Title [2025-10-02 141119 mmarianna | production-v2 | full]"), "2025-10-02 141119 mmarianna");
    assert.equal(inventoryRecordingId("2023-06-14 155500 [68190398] asahi"), null);
    assert.equal(inventoryRecordingId("2023-07-11 165800 [68190398]"), null);
});

test("xvideos inventory sync settles open confirmations from the complete listing, reporting the rest", async t => {
    const { db, config, r, attempt } = await fixture(t);
    db.attachUncertainRemote(attempt, "91753528");
    const listing = [
        { remoteId: "92078515", title: "Other [2026-01-20 140639 someone]", remoteUrl: "https://www.xvideos.com/video.a/x", status: "Pending release" },
        { remoteId: "85165541", title: "2023-07-11 165800 [68190398]", remoteUrl: "https://www.xvideos.com/video.b/y", status: "Blocked" },
    ];
    const report = await syncXvideosInventory(config, day(8), async () => ({
        withAuthenticatedPage: async run => run({}), listAccountUploads: async () => listing }));
    assert.deepEqual(report.confirmations.map(c => c.disposition), ["remote_id_missing", "absent_requeued"]);
    assert.equal(db.get(r.id).state, "metadata_ready");
    assert.equal(report.notInLedger.length, 2);
    assert.deepEqual(db.findProviderInventoryCopies("2026-01-20 140639 someone").map(c => c.remoteId), ["92078515"]);
    assert.deepEqual(db.findProviderInventoryCopies(r.id), []);
    await assert.rejects(syncXvideosInventory({ ...config, networkUploadsEnabled: false }), /opt-in/);
});

test("'Pending delete' copies count as gone: no duplicate, no blocking copy, stored ID treated as missing", async t => {
    const { db, config, r, attempt } = await fixture(t);
    db.attachUncertainRemote(attempt, "91788613");
    const report = await syncXvideosInventory(config, day(8), async () => ({ withAuthenticatedPage: async run => run({}),
        listAccountUploads: async () => [
            { remoteId: "91788613", title: `Old copy [${r.id}]`, remoteUrl: "https://www.xvideos.com/video.e/a", status: "Pending delete" },
            { remoteId: "91821388", title: "Kept [2026-03-20 123952 other]", remoteUrl: "https://www.xvideos.com/video.f/b", status: "Pending release" },
            { remoteId: "91788600", title: "Deleted dup [2026-03-20 123952 other]", remoteUrl: "https://www.xvideos.com/video.g/c", status: "Pending delete" },
        ] }));
    assert.deepEqual(report.confirmations.map(c => c.disposition), ["remote_id_missing", "absent_requeued"]);
    assert.equal(db.get(r.id).state, "metadata_ready");
    assert.deepEqual(db.findProviderInventoryCopies(r.id), []);
    assert.deepEqual(db.findProviderInventoryCopies("2026-03-20 123952 other").map(c => c.remoteId), ["91821388"]);
    assert.deepEqual(report.duplicateCopies, []);
    assert.deepEqual(report.removalPending.map(e => e.remoteId).sort(), ["91788600", "91788613"]);
    assert.equal(report.total, 3);
});

test("sync finds an existing copy by folder name and makes it due for normal verification", async t => {
    const { db, config, r, attempt } = await fixture(t);
    const report = await syncXvideosInventory(config, day(2), async () => ({ withAuthenticatedPage: async run => run({}),
        listAccountUploads: async () => [{ remoteId: "91957324", title: `Model title [${r.id}]`, remoteUrl: "https://www.xvideos.com/video.c/z", status: "Pending release" }] }));
    assert.equal(report.confirmations[0].disposition, "found_verification_due");
    assert.equal(db.getUncertainUploadRemote(attempt).remoteId, "91957324");
    assert.equal(db.get(r.id).state, "xvideos_uncertain");
    assert.equal(db.dueUploadConfirmations(day(2)).length, 1);
});

test("one active provider in SQLite; leaving XVideos requires a settled, synchronized account", async t => {
    const { db, config, attempt } = await fixture(t);
    assert.equal(db.getActiveUploadProvider(), "xvideos");
    assert.equal(activeUploadProvider({ databasePath: config.databasePath }), "xvideos");
    assert.equal(activeUploadProvider({ databasePath: config.databasePath, uploadProvider: "porntrex" }), "porntrex");
    db.setCampaignState("running", day(1));
    assert.throws(() => db.setActiveUploadProvider("porntrex", day(1)), /Pause the campaign/);
    db.setCampaignState("paused", day(1));
    assert.throws(() => db.setActiveUploadProvider("porntrex", day(1)), /unresolved upload confirmation/);
    db.attachUncertainRemote(attempt, "1");
    db.verifyUpload(attempt, "1", "https://www.xvideos.com/video.d/w", day(1));
    assert.throws(() => db.setActiveUploadProvider("porntrex", day(1)), /Synchronize the XVideos inventory/);
    db.replaceProviderInventory("xvideos", [], day(1));
    db.setActiveUploadProvider("porntrex", day(2));
    assert.equal(activeUploadProvider({ databasePath: config.databasePath }), "porntrex");
    assert.deepEqual(db.listUploadProviderEvents().map(e => [e.fromProvider, e.toProvider]), [["xvideos", "porntrex"]]);
    assert.throws(() => db.setActiveUploadProvider("bunkr"), /xvideos or porntrex/);
});

test("the local model's rewrite is kept only when clean; otherwise the full re-description still runs", async t => {
    const good = await fixture(t, { pending: false });
    good.db.recordRejectedPhrases("xvideos", ["ambien"], null);
    const seen = [];
    const verdict = await settleRejectedPhrases(good.db, good.r.id, "xvideos", new Date(), async (text, phrases) => {
        seen.push(phrases);
        return { title: text.title, description: text.description.replace(/ambient/i, "soft") };
    });
    assert.deepEqual(verdict, { kind: "rewritten", phrases: ["ambien"] });
    assert.equal(good.db.get(good.r.id).state, "metadata_ready");
    assert.match(good.db.getUploadMetadata(good.r.id).description, /^Purple soft lighting in a bedroom/);
    assert.match(good.db.getUploadMetadata(good.r.id).title, /\[2025-10-16 015701 example\]$/, "the folder identity suffix is recomposed, not lost");
    assert.equal((await checkRejectedPhrases(good.db, good.r.id, "xvideos")).kind, "clean");
    assert.deepEqual(seen, [["ambien"]]);

    const stubborn = await fixture(t, { pending: false });
    stubborn.db.recordRejectedPhrases("xvideos", ["ambien"], null);
    assert.equal((await settleRejectedPhrases(stubborn.db, stubborn.r.id, "xvideos", new Date(), async text => text)).kind, "stale_description");
    assert.equal(stubborn.db.get(stubborn.r.id).state, "artifact_valid");

    const broken = await fixture(t, { pending: false });
    broken.db.recordRejectedPhrases("xvideos", ["ambien"], null);
    assert.equal((await settleRejectedPhrases(broken.db, broken.r.id, "xvideos", new Date(), async () => { throw new Error("model down"); })).kind, "stale_description");
});
