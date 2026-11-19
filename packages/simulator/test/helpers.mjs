// Shared test fixtures: tiny generated media (never real footage) and a
// manual clock. ffmpeg runs at the lowest priority with two threads.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepAll } from '../dist/media/prep.js';
import { MediaLibrary } from '../dist/media/library.js';

export function tempDir(t, prefix = 'sim-') {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** A short test pattern with a tone. keyint 25 at 25 fps = a keyframe per second. */
export function makeVideo(file, { seconds = 4, size = '320x180', rate = 25, keyint = 25, audio = 'libopus' } = {}) {
    execFileSync('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(keyint), '-threads', '2',
        '-c:a', audio, '-b:a', '48k', file]);
}

/** Prepares one tiny source and returns its library. */
export async function preparedLibrary(t, { seconds = 6, name = 'Clip A.mkv' } = {}) {
    const root = tempDir(t);
    const input = path.join(root, 'in');
    mkdirSync(input);
    makeVideo(path.join(input, name), { seconds });
    const cache = path.join(root, 'cache');
    await prepAll({ input, out: cache });
    return { root, cache, library: MediaLibrary.load(cache) };
}

export function ffprobe(file, entries) {
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-of', 'json', ...entries, file]).toString());
}

/**
 * A media library described only by manifests (no files): enough for the
 * engine's timing, never for serving bytes.
 */
export function syntheticManifest({ id = 'synthetic', segments = 10, durationS = 1, twoSecond = 2 } = {}) {
    const seg = (prefix, n, d) => Array.from({ length: n }, (_, i) => ({ file: `${prefix}_${i}.x`, durationS: d, bytes: 1000, sha256: `${prefix}-${i}` }));
    const r = (rid, format, height, n, d) => ({
        id: rid, format, dir: rid, targetDurationS: d, width: Math.round(height * 16 / 9), height, frameRate: 25,
        codecs: 'avc1.64001f,mp4a.40.2', bandwidth: 1000000, averageBandwidth: 900000, loopDurationS: n * d,
        segments: seg(rid, n, d), ...(format === 'fmp4' ? { init: { file: 'init.mp4', bytes: 10, sha256: 'init' }, tracks: [] } : {}),
    });
    const half = Math.ceil(segments * durationS / twoSecond);
    return {
        version: 1, id, input: { file: 'x', bytes: 1, mtimeMs: 0 }, params: { minutes: null, maxHeight: 1080 }, videoCopied: false,
        renditions: {
            'ts': r('ts', 'ts', 720, segments, durationS), 'ts-alt': r('ts-alt', 'ts', 360, segments, durationS),
            'fmp4': r('fmp4', 'fmp4', 720, half, twoSecond), 'fmp4-alt': r('fmp4-alt', 'fmp4', 360, half, twoSecond),
            'ladder-720p': r('ladder-720p', 'ts', 720, half, twoSecond), 'ladder-480p': r('ladder-480p', 'ts', 480, half, twoSecond),
            'ladder-360p': r('ladder-360p', 'ts', 360, half, twoSecond),
        },
        groups: { ts: ['ts', 'ts-alt'], fmp4: ['fmp4', 'fmp4-alt'], ladder: ['ladder-720p', 'ladder-480p', 'ladder-360p'] },
        damage: [],
    };
}

export const EPOCH = Date.parse('2026-06-01T12:00:00.000Z');

/** fetch with a cookie jar, like a browser or an HTTP client keeping a session. */
export class CookieClient {
    constructor(base) { this.base = base; this.jar = new Map(); }
    cookie(name) { return this.jar.get(name); }
    set(name, value) { this.jar.set(name, value); }
    async fetch(path, init = {}) {
        const headers = new Headers(init.headers ?? {});
        if (this.jar.size) headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '));
        const res = await fetch(path.startsWith('http') ? path : this.base + path, { redirect: 'manual', ...init, headers });
        for (const c of res.headers.getSetCookie()) {
            const [pair] = c.split(';');
            const eq = pair.indexOf('=');
            this.jar.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
        }
        return res;
    }
    json(path, body, init = {}) {
        return this.fetch(path, { method: 'POST', ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, body: JSON.stringify(body) });
    }
}

export function variantsOf(master) {
    const lines = master.split('\n');
    const out = [];
    lines.forEach((line, i) => {
        if (!line.startsWith('#EXT-X-STREAM-INF:')) return;
        const res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
        out.push({ line, width: Number(res[1]), height: Number(res[2]), uri: lines[i + 1] });
    });
    return out;
}

export function segmentsOf(media) {
    const lines = media.split('\n');
    const seq = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(media)[1]);
    const out = [];
    let pdt = null;
    for (const line of lines) {
        if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = line.slice(25);
        else if (line && !line.startsWith('#')) { out.push({ seq: seq + out.length, uri: line, pdt }); pdt = null; }
    }
    return { mediaSequence: seq, segments: out, ended: media.includes('#EXT-X-ENDLIST') };
}

let shared = null;
/** One prepared tiny source per test process, removed when the process exits. */
export function sharedLibrary() {
    shared ??= (async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'sim-shared-'));
        process.on('exit', () => rmSync(root, { recursive: true, force: true }));
        const input = path.join(root, 'in');
        mkdirSync(input);
        makeVideo(path.join(input, 'Clip A.mkv'), { seconds: 6 });
        const cache = path.join(root, 'cache');
        await prepAll({ input, out: cache });
        return { root, cache, library: MediaLibrary.load(cache) };
    })();
    return shared;
}
