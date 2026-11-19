import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prepAll, ladderHeights, sourceIdFor } from '../dist/media/prep.js';
import { MediaLibrary } from '../dist/media/library.js';
import { countZeroSizeSamples, readBoxes } from '../dist/media/fmp4.js';
import { firstVideoPts } from '../dist/media/ts.js';
import { ffprobe, makeVideo, tempDir } from './helpers.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');

test('prep turns tiny videos into TS, fMP4, ladder and damage sets, and a re-run does nothing', async (t) => {
    const root = tempDir(t);
    const input = path.join(root, 'in');
    mkdirSync(input);
    // A: keyframe every second, H.264 at 25 fps: the video is copied.
    makeVideo(path.join(input, 'Clip A.mkv'), { seconds: 5 });
    // B: keyframe every 3 s: the video is re-encoded with one per second.
    makeVideo(path.join(input, 'clip_b.mkv'), { seconds: 5, keyint: 75, size: '426x240' });
    writeFileSync(path.join(input, 'notes.txt'), 'not a video');
    const cache = path.join(root, 'cache');
    const logs = [];
    const manifests = await prepAll({ input, out: cache, log: m => logs.push(m) });

    assert.deepEqual(manifests.map(m => m.id), ['clip-a', 'clip-b']);
    const [a, b] = manifests;
    assert.equal(a.videoCopied, true);
    assert.equal(b.videoCopied, false);
    for (const m of manifests) {
        const ts = m.renditions['ts'];
        assert.equal(ts.format, 'ts');
        assert.ok(ts.segments.length >= 4, 'about one TS segment per second');
        for (const s of ts.segments.slice(0, -1)) assert.ok(Math.abs(s.durationS - 1) < 0.05, `1 s segments, got ${s.durationS}`);
        const fm = m.renditions['fmp4'];
        assert.ok(fm.init && fm.tracks.some(tr => tr.handler === 'vide') && fm.tracks.some(tr => tr.handler === 'soun'));
        for (const s of fm.segments.slice(0, -1)) assert.ok(Math.abs(s.durationS - 2) < 0.05);
        assert.equal(m.groups.ladder.length, 3);
        const heights = m.groups.ladder.map(id => m.renditions[id].height);
        assert.deepEqual(heights, [...heights].sort((x, y) => y - x), 'ladder runs top to bottom');
        assert.ok(new Set(heights).size === 3);
        assert.ok(m.renditions['ts-alt'].height < ts.height, 'the alternate rendition changes resolution');
        assert.match(ts.codecs, /^avc1\.[0-9a-f]{6},mp4a\.40\.2$/);
        // Every listed hash and size matches the file on disk.
        for (const r of Object.values(m.renditions)) {
            for (const s of r.segments) {
                const data = readFileSync(path.join(cache, m.id, r.dir, s.file));
                assert.equal(data.length, s.bytes);
                assert.equal(sha(data), s.sha256);
            }
        }
        const kinds = new Set(m.damage.map(d => d.kind));
        assert.deepEqual([...kinds].sort(), ['resolution-boundary', 'single-frame', 'zero-byte', 'zero-size-sample']);
    }

    // Audio is AAC in every output even though the inputs carry Opus.
    const tsFile = path.join(cache, 'clip-a', 'ts', a.renditions['ts'].segments[0].file);
    const streams = ffprobe(tsFile, ['-show_streams']).streams;
    assert.deepEqual(streams.map(s => s.codec_name).sort(), ['aac', 'h264']);

    // Damage fixtures are what they claim to be.
    const single = a.damage.find(d => d.kind === 'single-frame');
    const frames = ffprobe(path.join(cache, 'clip-a', single.file), ['-count_frames', '-select_streams', 'v', '-show_streams']).streams[0];
    assert.equal(Number(frames.nb_read_frames), 1);
    const zero = a.damage.find(d => d.kind === 'zero-size-sample');
    assert.equal(countZeroSizeSamples(readFileSync(path.join(cache, 'clip-a', zero.file))), 1);
    assert.equal(a.damage.find(d => d.kind === 'zero-byte').bytes, 0);
    const boundary = ffprobe(path.join(cache, 'clip-a', a.damage.find(d => d.kind === 'resolution-boundary').file),
        ['-select_streams', 'v', '-show_frames', '-show_entries', 'frame=width']).frames;
    assert.ok(new Set(boundary.map(f => f.width)).size === 2, 'the boundary segment changes resolution mid-file');

    // Re-run: every stage is skipped and the manifest is untouched.
    const manifestPath = path.join(cache, 'clip-a', 'manifest.json');
    const before = statSync(manifestPath).mtimeMs;
    const logs2 = [];
    const again = await prepAll({ input, out: cache, log: m => logs2.push(m) });
    assert.deepEqual(again, manifests);
    assert.equal(logs2.filter(l => l.startsWith('  ')).length, 0, `no stage rebuilt: ${logs2.join(', ')}`);
    assert.equal(statSync(manifestPath).mtimeMs, before);
});

test('--minutes limits the media used, and an interrupted stage is rebuilt from scratch', async (t) => {
    const root = tempDir(t);
    const input = path.join(root, 'in');
    mkdirSync(input);
    makeVideo(path.join(input, 'long.mkv'), { seconds: 8 });
    const cache = path.join(root, 'cache');
    // A leftover from a run that died mid-stage.
    mkdirSync(path.join(cache, 'long', 'ts.partial'), { recursive: true });
    writeFileSync(path.join(cache, 'long', 'ts.partial', 'seg_00000.ts'), 'torn');
    const [m] = await prepAll({ input, out: cache, minutes: 0.05 });
    assert.ok(Math.abs(m.renditions['ts'].loopDurationS - 3) < 0.1, `3 s used, got ${m.renditions['ts'].loopDurationS}`);
    assert.equal(m.params.minutes, 0.05);
    const library = MediaLibrary.load(cache);
    assert.deepEqual(library.ids(), ['long']);
});

test('served segments keep rising across a loop of the source', async (t) => {
    const root = tempDir(t);
    const input = path.join(root, 'in');
    mkdirSync(input);
    makeVideo(path.join(input, 'loop.mkv'), { seconds: 3 });
    const cache = path.join(root, 'cache');
    await prepAll({ input, out: cache });
    const library = MediaLibrary.load(cache);
    const ts = library.rendition('loop', 'ts');
    const last = ts.segments.length - 1;
    const end = library.segmentBytes({ source: 'loop', rendition: 'ts', index: last, loop: 0 });
    const next = library.segmentBytes({ source: 'loop', rendition: 'ts', index: 0, loop: 1 });
    const step = (firstVideoPts(next) - firstVideoPts(end)) / 90000;
    assert.ok(Math.abs(step - ts.segments[last].durationS) < 0.05, `PTS advances by one segment across the loop, got ${step}`);
    // Continuity counters carry on too: each PID's first counter in the next
    // pass follows its last one in this pass.
    const counters = (data, which) => {
        const out = new Map();
        for (let at = 0; at + 188 <= data.length; at += 188) {
            if (!((data[at + 3] >> 4) & 1)) continue;
            const pid = ((data[at + 1] & 0x1f) << 8) | data[at + 2];
            if (which === 'first' && out.has(pid)) continue;
            out.set(pid, data[at + 3] & 0x0f);
        }
        return out;
    };
    const lastCc = counters(end, 'last'), firstCc = counters(next, 'first');
    assert.ok(firstCc.size >= 3);
    for (const [pid, cc] of firstCc) assert.equal(cc, (lastCc.get(pid) + 1) % 16, `PID ${pid} continues`);
    const fm = library.rendition('loop', 'fmp4');
    const shifted = library.segmentBytes({ source: 'loop', rendition: 'fmp4', index: 0, loop: 1 });
    const original = library.segmentBytes({ source: 'loop', rendition: 'fmp4', index: 0, loop: 0 });
    assert.equal(shifted.length, original.length);
    assert.ok(readBoxes(shifted).some(b => b.type === 'moof'));
    assert.notDeepEqual(shifted, original);
    const mfhdSeq = data => { const moof = readBoxes(data).find(b => b.type === 'moof'); return data.readUInt32BE(moof.start + 8 + 12); };
    assert.equal(mfhdSeq(shifted) - mfhdSeq(original), fm.segments.length, 'fragment numbers continue across the loop');
    assert.ok(fm.loopDurationS > 2);
});

test('ladder heights and source ids', () => {
    assert.deepEqual(ladderHeights(1080), [1080, 720, 480]);
    assert.deepEqual(ladderHeights(2160 > 1080 ? 1080 : 0), [1080, 720, 480]);
    assert.deepEqual(ladderHeights(720), [720, 480, 360]);
    assert.deepEqual(ladderHeights(180), [180, 120, 80]);
    assert.equal(sourceIdFor('/x/Final Set (2019) - Part 1.mp4'), 'final-set-2019-part-1');
});
