import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PipelineDatabase } from "../dist/db/pipelineDatabase.js";
import { pipelineConfig } from "../dist/config.js";
import { reconcileDueUploads } from "../dist/commands/reconcileUploads.js";
import { productionTargetDimensions } from "../dist/stages/upscale.js";
import { parsePlaybackRenditions, hasFullHdPlayback } from "../dist/upload/playbackQuality.js";
import { ChromiumXvideosUploader, HumanActionRequiredError } from "../dist/upload/chromiumXvideosUploader.js";
import { CURRENT_PRODUCTION_VERSION } from "../dist/domain/productionVersion.js";

const now = new Date("2026-10-01T00:00:00Z");
const tomorrow = new Date("2026-10-02T00:00:00Z");
async function fixture(t, remoteId) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipeline-v4-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = { ...pipelineConfig, databasePath: path.join(root, "pipeline.sqlite"),
        networkUploadsEnabled: true, cleanupEnabled: false, comparisonTrialOnly: false };
    const db = new PipelineDatabase(config.databasePath);
    t.after(() => db.close());
    const r = db.discover({ provider: "sc", sourceKind: "edited", sourcePath: path.join(root, "2026-09-11 120000 example"),
        playlistPath: path.join(root, "playlist.m3u8"), sourceFingerprint: "source", durationSeconds: 100 });
    db.transition(r.id, "server_ready", "remuxed");
    db.saveArtifact(r.id, { path: path.join(root, "file.mp4"), sizeBytes: 100, sha256: "a".repeat(64), validatedAt: now.toISOString() });
    db.saveDescription(r.id, { artifactSha256: "a".repeat(64), promptVersion: "test", fps: 1,
        output: { title: "Example", description: "Example" }, evidencePath: path.join(root, "evidence.json") });
    db.saveProvenance(r.id, { observedIdentifier:"example",status:"resolved",streamerId:"123",alias:"example",
        streamerUrl:"https://stripchat.com/123",aliasUrl:null,reason:null,updatedAt:now.toISOString() });
    db.saveUploadMetadata(r.id, { title: `Example [${r.id} | ${CURRENT_PRODUCTION_VERSION} | full]`, description: "Example", tags: [] });
    const reservation = db.reserveUpload(r.id, 1024, now);
    const attempt = db.beginUpload(r.id, reservation, now);
    db.finishUploadAttempt(attempt, { status: "uncertain", remoteId, transmittedBytes: 100,
        confirmation: { confirmAfter: now } }, now);
    return { config, db, r, attempt };
}

test("production Full-HD budget covers both orientations, custom aspects and non-square source pixels", () => {
    for (const [width, height, sar] of [[640,480,"1:1"],[480,640,"1:1"],[960,768,"1:1"],
        [768,960,"1:1"],[852,640,"640:639"],[720,1280,"1:1"],[1280,720,"1:1"],[2640,1440,"1:1"],
        [800,800,"1:1"]]) {
        const out = productionTargetDimensions({ width, height, sampleAspectRatio: sar });
        const [sn, sd] = sar.split(":").map(Number);
        const dar = width * sn / sd / height;
        assert(out.width * out.height >= 1920 * 1080);
        assert(Math.max(out.width,out.height)>=1920);
        assert(Math.min(out.width,out.height)>=1080);
        assert.equal(out.width % 2, 0); assert.equal(out.height % 2, 0);
        assert(Math.abs(out.width / out.height / dar - 1) < 0.002);
    }
    assert.deepEqual(productionTargetDimensions({width:640,height:480,sampleAspectRatio:"1:1"}),
        {width:1920,height:1440,displayAspectRatio:4/3});
});

test("actual v3 non-widescreen manifests fail Full-HD verification; portrait and landscape pass", () => {
    for (const size of ["1110x832", "1072x858", "1440x1080", "1350x1080"]) {
        const rs = parsePlaybackRenditions(`#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=${size},NAME="1080p"\nvideo.m3u8`);
        assert.equal(hasFullHdPlayback(rs), false, "misleading labels cannot substitute for pixels");
    }
    for (const size of ["1920x1080", "1080x1920", "1664x1248", "1610x1288", "2560x1440"]) {
        assert(hasFullHdPlayback(parsePlaybackRenditions(`#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=${size}\na.m3u8`)));
    }
    assert.equal(hasFullHdPlayback(parsePlaybackRenditions("<html>Login</html>")), false);
});

test("missing ID stays uncertain, retries daily across reopen, then attaches only recovered identity", async t => {
    const { config, db, r, attempt } = await fixture(t);
    let searches = 0;
    const browser = { withAuthenticatedPage: async run => run({}),
        recoverUploadId: async () => { searches++; return null; },
        probeUploadStatus: async () => { throw Error("No ID should be probed yet"); } };
    await reconcileDueUploads(config, now, browser);
    assert.equal(searches, 1);
    assert.equal(db.get(r.id).state, "xvideos_uncertain");
    assert.equal(db.dueUploadConfirmations(now).length, 0);
    const reopened = new PipelineDatabase(config.databasePath);
    assert.equal(reopened.dueUploadConfirmations(tomorrow)[0].attemptId, attempt);
    reopened.close();
    await reconcileDueUploads(config, tomorrow, { ...browser, recoverUploadId: async () => "12345",
        probeUploadStatus: async () => ({outcome:"online",remoteUrl:"https://www.xvideos.com/video.example",renditions:[{width:1664,height:1248,label:"1080p"}]}) });
    assert.equal(db.get(r.id).state, "xvideos_verified");
    assert.equal(db.getUploadIdentity(r.id).remoteId, "12345");
    assert.equal(db.dueUploadConfirmations(tomorrow).length, 0);
});

test("verification login failure gets a durable daily retry, never an absent verdict", async t => {
    const { config, db, r } = await fixture(t, "12345");
    await reconcileDueUploads(config, now, { withAuthenticatedPage: async () => { throw Error("temporary login timeout"); },
        probeUploadStatus: async () => { throw Error("not reached"); } });
    assert.equal(db.get(r.id).state, "xvideos_uncertain");
    assert.equal(db.dueUploadConfirmations(now).length, 0);
    assert.equal(db.dueUploadConfirmations(tomorrow).length, 1);
    assert.match(JSON.stringify(db.latestUploadDiagnostics(r.id)), /temporary login timeout/);
});

test("published 720p remains pending and rechecks the same ID, without another upload", async t => {
    const { config, db, r } = await fixture(t, "12345");
    let probes = 0;
    const b = {withAuthenticatedPage: async run => run({}), probeUploadStatus: async (_, id) => {
        assert.equal(id,"12345"); probes++;
        return { outcome:"not_ready",remoteUrl:"https://www.xvideos.com/video.example",reason:"Full-HD missing",
            renditions:[{width:1110,height:832,label:"720p"}] };
    }};
    await reconcileDueUploads(config, now, b);
    await reconcileDueUploads(config, new Date(now.getTime()+60_000), b);
    assert.equal(probes,1);
    await reconcileDueUploads(config, tomorrow, b);
    assert.equal(probes,2);
    assert.equal(db.get(r.id).state,"xvideos_uncertain");
    assert.equal(db.latestUploadDiagnostics(r.id).confirmation_status,"pending");
});

test("recovery refuses older versions and ambiguous diagnostic identities", async () => {
    const b = new ChromiumXvideosUploader({});
    const identity = `example | ${CURRENT_PRODUCTION_VERSION} | full`;
    b.findEntries = async () => [{remoteId:"1",title:"Example [example | production-v3 | full]"}];
    assert.equal(await b.recoverUploadId({},identity),null);
    b.findEntries = async () => [{remoteId:"2",title:`Example [${identity}]`},{remoteId:"3",title:`Example [${identity}]`}];
    assert.equal(await b.recoverUploadId({},identity),null);
    b.findEntries = async () => [{remoteId:"2",title:`Example [${identity}]`}];
    assert.equal(await b.recoverUploadId({},identity),"2");
});

test("generic login timeout is classified for retries; completed instant OAuth is accepted", async () => {
    const b = new ChromiumXvideosUploader({});
    b.ensureAuthenticated = async () => { throw Error("Sign in with Google timed out"); };
    b.verifyAccountDashboard = async () => false;
    await assert.rejects(() => b.authenticateForUpload({context:()=>({})}), e => e instanceof HumanActionRequiredError && e.action==="session_login");
    b.verifyAccountDashboard = async () => true;
    await b.authenticateForUpload({context:()=>({})});
});
