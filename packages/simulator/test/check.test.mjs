import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SimClock } from '../dist/clock.js';
import { checkRecording, formatReport, normalizeRecordingId } from '../dist/check/checker.js';
import { startSimulator } from '../dist/serve.js';
import { TruthIndex } from '../dist/truth/query.js';
import { EPOCH, sharedLibrary, segmentsOf, tempDir, variantsOf } from './helpers.mjs';

const CLI = path.resolve('dist/cli.js');

/**
 * Records a channel the way the capture client does: polls the media
 * playlist, saves each new segment as <local>_<recordingId>_<providerSeq>.ts,
 * keeps playlist.m3u8 (EXTINF, MAP, DISCONTINUITY), and after an edge switch
 * continues by program date-time. `overlapAtSwitch` re-takes the last
 * segment from the new edge (a dedup failure: a duplicate).
 */
async function record(base, clock, dir, { channel, from, to, step = 2, switchAt = Infinity, overlapAtSwitch = false }) {
    mkdirSync(dir, { recursive: true });
    const cam = await (await fetch(`${base}/api/channels/${channel}/stream`)).json();
    const rid = normalizeRecordingId(cam.stream.statusSince);
    const mediaUrls = {};
    const mediaUrl = async edge => {
        if (!mediaUrls[edge]) {
            const master = cam.stream.masterUrls[edge];
            mediaUrls[edge] = new URL(variantsOf(await (await fetch(master)).text())[0].uri, master).toString();
        }
        return mediaUrls[edge];
    };
    const saved = [];
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0'];
    let local = 0, edge = 'a', lastEdge = null, lastSeq = null, lastPdt = null, haveInit = false;
    for (let s = from; s <= to; s += step) {
        clock.set(EPOCH + s * 1000);
        if (s >= switchAt && edge === 'a') {
            edge = 'b';
            if (overlapAtSwitch) lastPdt = saved.at(-2).pdt;
        }
        const url = await mediaUrl(edge);
        const res = await fetch(url);
        if (res.status !== 200) continue;
        const text = await res.text();
        if (!haveInit) {
            const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)[1];
            writeFileSync(path.join(dir, 'init.mp4'), Buffer.from(await (await fetch(new URL(map, url))).arrayBuffer()));
            lines.push('#EXT-X-MAP:URI="init.mp4"');
            haveInit = true;
        }
        for (const seg of segmentsOf(text).segments) {
            const isNew = lastSeq === null ? true : edge === lastEdge ? seg.seq > lastSeq : Date.parse(seg.pdt) > Date.parse(lastPdt);
            if (!isNew) continue;
            const bytes = Buffer.from(await (await fetch(new URL(seg.uri, url))).arrayBuffer());
            const name = `${local++}_${rid}_${seg.seq}.ts`;
            writeFileSync(path.join(dir, name), bytes);
            if (lastEdge !== null && (edge !== lastEdge || seg.seq !== lastSeq + 1)) lines.push('#EXT-X-DISCONTINUITY');
            lines.push('#EXTINF:2.000,', name);
            saved.push({ name, seq: seg.seq, pdt: seg.pdt, edge });
            lastSeq = seg.seq; lastPdt = seg.pdt; lastEdge = edge;
        }
    }
    lines.push('#EXT-X-ENDLIST');
    writeFileSync(path.join(dir, 'playlist.m3u8'), lines.join('\n') + '\n');
    return { rid, saved };
}

function dropFromPlaylist(dir, name) {
    const file = path.join(dir, 'playlist.m3u8');
    const lines = readFileSync(file, 'utf8').split('\n');
    const i = lines.indexOf(name);
    lines.splice(i - 1, 2);
    writeFileSync(file, lines.join('\n'));
}

async function fmp4Sim(t, extra = {}) {
    const media = await sharedLibrary();
    const dir = tempDir(t);
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 10_000 });
    const sim = await startSimulator({
        scenario: { name: 'check', seed: 'check-seed', epoch: EPOCH, segmentRetentionS: 60, sites: { 'fmp4-live': { channels: [
            { id: '77', name: 'centre', startPosition: 0, schedule: { sessions: [{ start: 0, end: 300 }] },
              edges: [{ id: 'a', firstSequence: 500 }, { id: 'b', firstSequence: 20, lagMs: 400 }],
              faults: [{ type: 'skip', at: 30, count: 1, edge: 'a' }] },
        ] } } },
        media: media.library, clock, autoPublish: false, truthFile: path.join(dir, 'truth.jsonl'), ...extra,
    });
    t.after(() => sim.close());
    return { sim, clock, dir, media, base: sim.urls['fmp4-live'] };
}

test('the checker tells client misses from site skips, and finds duplicates and byte mismatches', async (t) => {
    const { sim, clock, dir, base, media } = await fmp4Sim(t);
    const rec = path.join(dir, 'rec');
    const { rid, saved } = await record(base, clock, rec, { channel: '77', from: 10, to: 70, switchAt: 50, overlapAtSwitch: true });
    sim.sim.truth.flush();

    // The untouched recording: the provider skip and the duplicate at the switch only.
    let truth = TruthIndex.fromFile(sim.truthFile);
    let report = checkRecording(truth, rec, { site: 'fmp4-live', channel: '77' });
    assert.equal(report.recording.recordingId, rid);
    assert.equal(report.counts.missedByClient, 0, formatReport(report));
    assert.equal(report.counts.skippedBySite, 1);
    const skip = report.skippedBySite[0];
    assert.deepEqual(skip.clientEdges, ['a']);
    assert.deepEqual(skip.availableOn.map(x => x.edge), ['b'], 'another edge carried it');
    assert.equal(report.counts.duplicates, 1);
    const dup = report.duplicates[0];
    assert.equal(dup.files.length, 2);
    assert.notEqual(dup.files[0].split('_')[2], dup.files[1].split('_')[2], 'same media, two edges, two sequence numbers');
    assert.equal(report.counts.byteMismatches, 0);
    assert.equal(report.counts.exact, saved.length);
    assert.deepEqual(report.recording.initFiles.map(i => i.known), [true]);
    assert.equal(report.ok, false, 'a duplicate is a problem');

    // Lose a segment (a client miss) and damage another file (a byte mismatch).
    const lost = saved[3];
    unlinkSync(path.join(rec, lost.name));
    dropFromPlaylist(rec, lost.name);
    const broken = saved[6];
    const bytes = readFileSync(path.join(rec, broken.name));
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(path.join(rec, broken.name), bytes);
    // The stream went on after the client stopped.
    clock.set(EPOCH + 90_000);
    sim.sim.truth.flush();
    truth = TruthIndex.fromFile(sim.truthFile);
    report = checkRecording(truth, rec, { site: 'fmp4-live', channel: '77', media: media.library });
    assert.equal(report.counts.missedByClient, 1);
    const miss = report.missedByClient[0];
    assert.deepEqual(miss.edges.map(e => [e.edge, e.seq]), [['a', lost.seq]]);
    assert.ok(miss.edges[0].listed.until - miss.edges[0].listed.from >= 4000, 'it was listed for seconds: the client could have had it');
    assert.equal(report.counts.byteMismatches, 1);
    assert.equal(report.byteMismatches[0].file, broken.name);
    assert.equal(report.byteMismatches[0].expected[0].sha256.length, 64);
    assert.equal(report.counts.skippedBySite, 1);
    const summary = formatReport(report);
    assert.match(summary, /missed by the client: 1 \(k \d+\)/);
    assert.match(summary, /skipped by the site: 1 \(k \d+; 1 were on another edge\)/);
    assert.match(summary, /verdict: FAIL/);

    assert.ok(report.counts.outsideExpected.after >= 8, 'published after the last file');
    assert.ok(report.counts.outsideExpected.before <= 1, 'the server started when the client did (edge b lags by one)');

    // The whole session was expected: what came after the last file is missed too.
    const whole = checkRecording(truth, rec, { site: 'fmp4-live', channel: '77', expect: { mode: 'whole-session' } });
    // (Edge b lags: the oldest position may be on b only, and the newest may not
    // have reached b when the log ends; on the edge the client read, those count as skipped.)
    const { before, after } = report.counts.outsideExpected;
    assert.equal(whole.counts.missedByClient + whole.counts.skippedBySite, 1 + 1 + before + after);
    assert.ok(whole.counts.missedByClient >= report.counts.outsideExpected.after);
    assert.ok(whole.missedByClient.slice(1).every(m => m.edges[0].edge === 'b'), 'on the edge it was reading last');

    // The command line: JSON on stdout, the summary on stderr, exit 1 for problems.
    const cli = spawnSync(process.execPath, [CLI, 'check', '--truth', sim.truthFile, '--recording', rec, '--site', 'fmp4-live', '--channel', '77'], { encoding: 'utf8' });
    assert.equal(cli.status, 1, cli.stderr);
    const json = JSON.parse(cli.stdout);
    assert.equal(json.counts.missedByClient, 1);
    assert.match(cli.stderr, /verdict: FAIL/);
    const usage = spawnSync(process.execPath, [CLI, 'check', '--truth', sim.truthFile], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
});

test('a clean recording passes; unhashed truth is unverified without media and exact with it', async (t) => {
    const media = await sharedLibrary();
    const clock = new SimClock({ mode: 'manual', at: EPOCH + 10_000 });
    const sim = await startSimulator({
        scenario: { name: 'clean', seed: 'clean', epoch: EPOCH, sites: { 'ts-live': {
            accounts: [{ username: 'u', password: 'p', accountId: 'acct' }],
            channels: [{ id: 'chan', name: 'court', startPosition: 0, schedule: { always: true }, edges: [{ id: 'a', firstSequence: 1000 }] }],
        } } },
        media: media.library, clock, autoPublish: false, memoryTruth: true, hashBudget: 2,
    });
    t.after(() => sim.close());
    clock.set(EPOCH + 40_000);
    const truth = new TruthIndex(sim.memory.records);
    const [session] = truth.sessions({ site: 'ts-live', channel: 'chan' });
    const segs = truth.available({ site: 'ts-live', channel: 'chan', edge: 'a', tier: 'ts' }).slice(5, 20);
    assert.ok(segs.some(s => s.sha256 === null), 'the catch-up left hashes out');
    const dir = path.join(tempDir(t), 'rec');
    mkdirSync(dir);
    segs.forEach((s, i) => writeFileSync(path.join(dir, `${i}_${session.recordingId}_${s.seq}.ts`),
        media.library.segmentBytes({ source: session.source, rendition: s.rendition, index: s.srcIndex, loop: s.loop, damage: s.damage })));
    writeFileSync(path.join(dir, 'playlist.m3u8'), ['#EXTM3U', '#EXT-X-TARGETDURATION:1', ...segs.flatMap((s, i) => ['#EXTINF:1.000,', `${i}_${session.recordingId}_${s.seq}.ts`])].join('\n') + '\n');

    let report = checkRecording(truth, dir, { site: 'ts-live', channel: 'chan' });
    assert.equal(report.counts.unverified, segs.filter(s => s.sha256 === null).length);
    assert.equal(report.counts.byteMismatches, 0);
    report = checkRecording(truth, dir, { site: 'ts-live', channel: 'chan', media: media.library });
    assert.equal(report.counts.exact, segs.length);
    assert.equal(report.ok, true, formatReport(report));
    assert.equal(report.recording.playlist.ended, false);
    assert.equal(report.expected.positions, segs.length);

    // A file the site never published, and one that is not in the playlist.
    copyFileSync(path.join(dir, readdirSync(dir).find(n => n.startsWith('0_'))), path.join(dir, `99_${session.recordingId}_5.ts`));
    report = checkRecording(truth, dir, { site: 'ts-live', channel: 'chan', media: media.library });
    assert.equal(report.counts.unknownFiles, 1);
    assert.match(report.unknownFiles[0].reason, /provider sequence 5/);
    assert.deepEqual(report.recording.playlist.unreferencedFiles, [`99_${session.recordingId}_5.ts`]);
    // A time window wider than the recording: the positions before it are the client's misses.
    const wide = checkRecording(truth, dir, { site: 'ts-live', channel: 'chan', media: media.library, expect: { mode: 'window', from: EPOCH + 10_000, to: EPOCH + 40_000 } });
    assert.ok(wide.counts.missedByClient >= 5);
    rmSync(path.join(dir, `99_${session.recordingId}_5.ts`));
    writeFileSync(path.join(dir, `0_other-identity_1000.ts`), 'x');
    report = checkRecording(truth, dir, { site: 'ts-live', channel: 'chan' });
    assert.equal(report.ok, false);
    assert.match(report.unknownFiles[0].reason, /mixes recording identities/);
});

test('UTC recording identities are stored without colons', () => {
    assert.equal(normalizeRecordingId('2026-08-12T09:08:47Z'), '2026-08-12T090847Z');
    assert.equal(normalizeRecordingId('2026-08-12T09:08:47.250Z'), '2026-08-12T090847Z');
    assert.equal(normalizeRecordingId('1717243200'), '1717243200');
});
