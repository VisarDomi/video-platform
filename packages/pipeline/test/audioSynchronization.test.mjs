import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixturePart, assemble, audioPackets, exec } from './helpers/mediaFixture.mjs';
import { convertShapeGroup } from '../dist/stages/upscale.js';
import { convertIndependentNativeRuns } from '../dist/stages/normalizeInputRuns.js';
import { probeNativeStreamLayout } from '../dist/stages/mediaCompatibility.js';

async function temporary(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'audio-sync-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

async function timeline(input) {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_packets', '-show_streams',
        '-show_entries', 'stream=index,codec_type:packet=stream_index,pts_time,side_data_list', '-of', 'json', input]);
    const d = JSON.parse(stdout);
    const packets = type => d.packets.filter(p => p.stream_index === d.streams.find(s => s.codec_type === type).index);
    return { video: Math.min(...packets('video').map(p => Number(p.pts_time))), audio: packets('audio') };
}

for (const fmp4 of [false, true]) for (const audioOffset of [0, 0.080]) {
    test(`${fmp4 ? 'fMP4' : 'TS'} conversion preserves the original A/V offset (${audioOffset}s), not a frame-rounded origin`, async t => {
        const root = await temporary(t);
        const part = await fixturePart(root, 'source', { frames: 10, fmp4, audioOffset });
        const source = await timeline(part.input);
        const playlist = await assemble(root, [part]);
        const before = await readFile(playlist, 'utf8');
        const converted = await convertShapeGroup(playlist, path.join(root, 'out'), 'sync',
            { output: { width: 320, height: 180, rotate: false } }, 'timing');
        const output = await timeline(converted.path);
        const inputOffset = Number(source.audio[0].pts_time) - source.video;
        const outputOffset = Number(output.audio[0].pts_time) - output.video;
        assert(Math.abs(outputOffset - inputOffset) < 0.000050,
            `conversion added ${(outputOffset - inputOffset) * 1000} ms of A/V skew`);
        assert.deepEqual((await audioPackets(converted.path)).map(p => p.data_hash),
            (await audioPackets(part.input)).map(p => p.data_hash), 'AAC payloads are unchanged');
        assert.equal(await readFile(playlist, 'utf8'), before);
    });
}

test('independent-run AAC encoding signals its priming and keeps reference PCM pulses on the video timeline', async t => {
    const root = await temporary(t), reference = new Float32Array(96000), runs = [];
    for (let i = 0; i < 2; i++) {
        const pcm = Buffer.alloc(48000 * 4);
        let seed = 123456 + i;
        for (let j = 24000; j < 24480; j++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const sample = ((seed / 2 ** 32) * 2 - 1) * 0.6;
            pcm.writeFloatLE(sample, j * 4); reference[i * 48000 + j] = sample;
        }
        const audio = path.join(root, `${i}.pcm`), input = path.join(root, `${i}.nut`);
        await writeFile(audio, pcm);
        await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x180:r=10:d=1',
            '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', audio, '-c:v', 'libx264', '-preset', 'ultrafast',
            '-bf', '0', '-c:a', 'pcm_s16le', '-t', '1', '-f', 'nut', input]);
        runs.push({ path: input, durationSeconds: 1, layout: await probeNativeStreamLayout(input) });
    }
    const output = path.join(root, 'converted.mp4');
    await convertIndependentNativeRuns(runs, output, { outputWidth: 320, outputHeight: 180 });
    const encoded = await timeline(output);
    assert.equal(encoded.video, 0);
    assert(Number(encoded.audio[0].pts_time) < 0, 'AAC priming has a pre-roll timestamp');
    assert(encoded.audio[0].side_data_list?.some(s => s.skip_samples > 0), 'MP4 signals samples to skip');
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:a:0', '-ac', '1',
        '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    const decoded = Array.from({ length: stdout.length / 4 }, (_, i) => stdout.readFloatLE(i * 4));
    for (const center of [24000, 72000]) {
        let best = -Infinity, lag = null;
        for (let shift = -2300; shift <= 2300; shift++) {
            let score = 0;
            for (let j = center - 64; j < center + 544; j++) score += reference[j] * decoded[j + shift];
            if (score > best) { best = score; lag = shift; }
        }
        assert(Math.abs(lag) <= 1, `AAC added ${lag} samples of unreported delay at ${center / 48000}s`);
    }
});
