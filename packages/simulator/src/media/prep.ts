// Prepares a folder of videos into the cache the simulated sites serve from.
//
// Per input: a mezzanine (H.264 with a keyframe every second, AAC audio), then
// segment sets cut from it without re-encoding: 1 s MPEG-TS, 2 s fMP4 with an
// init segment, a three-rung TS ladder, alternate low renditions for
// resolution changes, and damage fixtures. Each stage is built in a scratch
// directory and renamed into place when complete, so an interrupted run
// resumes where it stopped and a finished run is skipped.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, openSync, fsyncSync, closeSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ffmpeg, keyframeTimes, probe, type StreamFacts, type ToolOptions } from "./ffmpeg.js";
import { insertZeroSizeSample, trackInfo } from "./fmp4.js";
import { continuitySteps, truncateToFirstFrame } from "./ts.js";
import { fsyncDir, writeJsonDurable } from "../fsutil.js";
import { sha256, hashHex } from "../rng.js";
import { MANIFEST_VERSION, type DamageEntry, type RenditionManifest, type SegmentEntry, type SourceManifest } from "./manifest.js";

const STAGE_VERSION = "2";
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".ts", ".avi"]);

export interface PrepOptions {
    input: string;
    out: string;
    /** Use only the first N minutes of each input. */
    minutes?: number | null;
    maxHeight?: number;
    maxFps?: number;
    /** How many damage fixtures of each kind to write. */
    damageCount?: number;
    tools?: ToolOptions;
    log?: (message: string) => void;
}

export function sourceIdFor(file: string): string {
    const slug = basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug.slice(0, 48) || "source";
}

export function listInputs(dir: string): string[] {
    return readdirSync(dir)
        .filter(name => VIDEO_EXTENSIONS.has(extname(name).toLowerCase()) && !name.startsWith("."))
        .sort()
        .map(name => join(dir, name));
}

export async function prepAll(options: PrepOptions): Promise<SourceManifest[]> {
    const inputs = listInputs(options.input);
    if (inputs.length === 0) throw new Error(`no video files in ${options.input}`);
    const seen = new Map<string, string>();
    for (const file of inputs) {
        const id = sourceIdFor(file);
        if (seen.has(id)) throw new Error(`${file} and ${seen.get(id)} map to the same source id "${id}"; rename one`);
        seen.set(id, file);
    }
    mkdirSync(options.out, { recursive: true });
    const manifests: SourceManifest[] = [];
    for (const file of inputs) manifests.push(await prepSource(file, options));
    return manifests;
}

function fsyncTree(dir: string): void {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { fsyncTree(path); continue; }
        const fd = openSync(path, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    fsyncDir(dir);
}

/** Builds `dir/name` once per key; a partial build from an interrupted run is discarded. */
async function stage(dir: string, name: string, key: string, log: (m: string) => void,
    build: (scratch: string) => Promise<void>): Promise<string> {
    const final = join(dir, name);
    const marker = join(final, ".done");
    if (existsSync(marker) && readFileSync(marker, "utf8") === key) return final;
    const scratch = `${final}.partial`;
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    log(`  ${name}`);
    await build(scratch);
    writeFileSync(join(scratch, ".done"), key);
    fsyncTree(scratch);
    rmSync(final, { recursive: true, force: true });
    renameSync(scratch, final);
    fsyncDir(dir);
    return final;
}

const BITEXACT = ["-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact"];

function maxrateFor(height: number): number {
    if (height >= 1080) return 5000;
    if (height >= 720) return 2800;
    if (height >= 480) return 1400;
    if (height >= 360) return 900;
    return 500;
}

/** Three rung heights: the source height, then standard steps below it. */
export function ladderHeights(sourceHeight: number): number[] {
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const rungs = [even(sourceHeight)];
    for (const h of [1080, 720, 480, 360, 240]) if (h < rungs[0] && rungs.length < 3) rungs.push(h);
    while (rungs.length < 3) rungs.push(even(rungs[rungs.length - 1] * 2 / 3));
    return rungs;
}

function segmentArgs(format: "ts" | "fmp4", seconds: 1 | 2, scratch: string): string[] {
    // The HLS muxer cuts at the first keyframe at or after N x hls_time. With
    // a keyframe on every whole second, 0.5 cuts at each one; 2 cuts at every
    // second one (forced keyframes land on or just after the second).
    const common = ["-f", "hls", "-hls_time", seconds === 1 ? "0.5" : "2", "-hls_list_size", "0", "-hls_playlist_type", "vod"];
    return format === "ts"
        ? [...common, "-hls_segment_type", "mpegts", "-hls_segment_filename", join(scratch, "seg_%05d.ts"), join(scratch, "index.m3u8")]
        : [...common, "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
            "-hls_segment_filename", join(scratch, "seg_%05d.m4s"), join(scratch, "index.m3u8")];
}

function parsePlaylist(dir: string): Array<{ file: string; durationS: number }> {
    const lines = readFileSync(join(dir, "index.m3u8"), "utf8").split(/\r?\n/);
    const out: Array<{ file: string; durationS: number }> = [];
    let duration: number | null = null;
    for (const line of lines) {
        if (line.startsWith("#EXTINF:")) duration = parseFloat(line.slice(8));
        else if (line && !line.startsWith("#") && duration !== null) { out.push({ file: line.trim(), durationS: duration }); duration = null; }
    }
    return out;
}

const segmentSteps = new WeakMap<RenditionManifest, Array<Record<string, number>>>();

function sumSteps(list: Array<Record<string, number>>): Record<string, number> {
    const total: Record<string, number> = {};
    for (const steps of list) for (const [pid, n] of Object.entries(steps)) total[pid] = ((total[pid] ?? 0) + n) % 16;
    return total;
}

function codecsFor(facts: StreamFacts): string {
    const parts: string[] = [];
    if (facts.video) {
        const profile = (facts.video.profile ?? "High").toLowerCase();
        const [idc, constraint] = profile.includes("baseline") ? [0x42, 0xe0] : profile === "main" ? [0x4d, 0x40] : [0x64, 0x00];
        const hex = (n: number) => n.toString(16).padStart(2, "0");
        parts.push(`avc1.${hex(idc)}${hex(constraint)}${hex(facts.video.level ?? 31)}`);
    }
    if (facts.audio) parts.push("mp4a.40.2");
    return parts.join(",");
}

async function describeRendition(id: string, format: "ts" | "fmp4", dir: string, relDir: string, targetDurationS: number,
    encoded: string, tools: ToolOptions): Promise<RenditionManifest> {
    const listed = parsePlaylist(dir);
    const perSegmentSteps: Array<Record<string, number>> = [];
    const segments: SegmentEntry[] = listed.map(({ file, durationS }) => {
        const data = readFileSync(join(dir, file));
        if (format === "ts") perSegmentSteps.push(continuitySteps([data]));
        return { file, durationS: Math.round(durationS * 1e6) / 1e6, bytes: data.length, sha256: sha256(data) };
    });
    if (segments.length === 0) throw new Error(`${relDir}: no segments`);
    const facts = await probe(encoded, tools);
    const rates = segments.map(s => s.bytes * 8 / Math.max(s.durationS, 0.001));
    const total = segments.reduce((sum, s) => sum + s.durationS, 0);
    const rendition: RenditionManifest = {
        id, format, dir: relDir, targetDurationS,
        width: facts.video?.width ?? 0, height: facts.video?.height ?? 0,
        frameRate: Math.round((facts.video?.fps ?? 0) * 1000) / 1000,
        codecs: codecsFor(facts),
        bandwidth: Math.ceil(Math.max(...rates)),
        averageBandwidth: Math.ceil(segments.reduce((sum, s) => sum + s.bytes * 8, 0) / total),
        loopDurationS: Math.round(total * 1e6) / 1e6,
        segments,
        ...(format === "ts" ? { continuitySteps: sumSteps(perSegmentSteps) } : {}),
    };
    if (format === "ts") segmentSteps.set(rendition, perSegmentSteps);
    if (format === "fmp4") {
        const init = readFileSync(join(dir, "init.mp4"));
        rendition.init = { file: "init.mp4", bytes: init.length, sha256: sha256(init) };
        rendition.tracks = trackInfo(init);
    }
    return rendition;
}

export async function prepSource(file: string, options: PrepOptions): Promise<SourceManifest> {
    const log = options.log ?? (() => undefined);
    const tools = options.tools ?? {};
    const threads = String(tools.threads ?? 2);
    const maxHeight = options.maxHeight ?? 1080;
    const maxFps = options.maxFps ?? 30;
    const minutes = options.minutes ?? null;
    const damageCount = options.damageCount ?? 4;
    const id = sourceIdFor(file);
    const dir = join(options.out, id);
    mkdirSync(dir, { recursive: true });
    const st = statSync(file);
    const input = { file: basename(file), bytes: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    const baseKey = hashHex(STAGE_VERSION, JSON.stringify(input), String(minutes), String(maxHeight), String(maxFps));
    log(`${id}: ${file}`);

    const source = await probe(file, tools);
    if (!source.video) throw new Error(`${file}: no video stream`);
    const limitS = minutes === null ? null : minutes * 60;

    // Copy the source video only when it already is what a live site would
    // send: H.264, within the size and rate caps, a keyframe about every second.
    let copyVideo = false;
    if (source.video.codec === "h264" && source.video.height <= maxHeight && source.video.fps <= maxFps + 0.01) {
        const keys = await keyframeTimes(file, limitS ?? source.durationS, tools);
        const gaps = keys.slice(1).map((t, i) => t - keys[i]);
        copyVideo = gaps.length > 2 && gaps.every(g => g >= 0.8 && g <= 1.25);
    }
    const mezzHeight = Math.min(source.video.height, maxHeight);

    const mezzDir = await stage(dir, "work-mezzanine", `${baseKey}:${copyVideo}`, log, async scratch => {
        const video = copyVideo ? ["-c:v", "copy"] : [
            "-vf", `scale=-2:${mezzHeight}`, "-fpsmax", String(maxFps),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high", "-pix_fmt", "yuv420p",
            "-maxrate", `${maxrateFor(mezzHeight)}k`, "-bufsize", `${2 * maxrateFor(mezzHeight)}k`,
            "-sc_threshold", "0", "-g", "600", "-force_key_frames", "expr:gte(t,n_forced*1)", "-threads", threads,
        ];
        await ffmpeg([
            ...(limitS === null ? [] : ["-t", String(limitS)]), "-i", file,
            "-map", "0:v:0", "-map", "0:a:0?", ...video,
            "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-threads", threads,
            ...BITEXACT, join(scratch, "mezzanine.mp4"),
        ], tools);
    });
    const mezzanine = join(mezzDir, "mezzanine.mp4");
    const mezzFacts = await probe(mezzanine, tools);
    const heights = ladderHeights(mezzFacts.video!.height);
    const mezzKey = `${baseKey}:${copyVideo}`;

    // Lower rungs, encoded from the mezzanine with keyframes where it has them.
    const rungFile = new Map<number, string>();
    rungFile.set(heights[0], mezzanine);
    for (const h of heights.slice(1)) {
        const rungDir = await stage(dir, `work-rung-${h}`, `${mezzKey}:rung:${h}`, log, async scratch => {
            await ffmpeg([
                "-i", mezzanine, "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", `scale=-2:${h}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "main",
                "-pix_fmt", "yuv420p", "-maxrate", `${maxrateFor(h)}k`, "-bufsize", `${2 * maxrateFor(h)}k`,
                "-sc_threshold", "0", "-g", "600", "-force_key_frames", "source", "-threads", threads,
                "-c:a", "copy", ...BITEXACT, join(scratch, "rung.mp4"),
            ], tools);
        });
        rungFile.set(h, join(rungDir, "rung.mp4"));
    }
    const low = rungFile.get(heights[heights.length - 1])!;

    const segmentSets: Array<{ id: string; from: string; format: "ts" | "fmp4"; seconds: 1 | 2 }> = [
        { id: "ts", from: mezzanine, format: "ts", seconds: 1 },
        { id: "fmp4", from: mezzanine, format: "fmp4", seconds: 2 },
        { id: "ts-alt", from: low, format: "ts", seconds: 1 },
        { id: "fmp4-alt", from: low, format: "fmp4", seconds: 2 },
        ...heights.map(h => ({ id: `ladder-${h}p`, from: rungFile.get(h)!, format: "ts" as const, seconds: 2 as const })),
    ];
    const renditions: Record<string, RenditionManifest> = {};
    for (const set of segmentSets) {
        const out = await stage(dir, set.id, `${mezzKey}:${set.id}:${heights.join(",")}`, log, async scratch => {
            await ffmpeg(["-i", set.from, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", ...BITEXACT,
                ...segmentArgs(set.format, set.seconds, scratch)], tools);
        });
        renditions[set.id] = await describeRendition(set.id, set.format, out, set.id, set.seconds, set.from, tools);
    }

    // Sets meant to switch index by index must cut at the same instants; a
    // trailing partial segment is dropped from the longer one.
    const groups: Record<string, string[]> = {
        ts: ["ts", "ts-alt"],
        fmp4: ["fmp4", "fmp4-alt"],
        ladder: heights.map(h => `ladder-${h}p`),
    };
    for (const [group, members] of Object.entries(groups)) {
        const count = Math.min(...members.map(m => renditions[m].segments.length));
        const reference = renditions[members[0]].segments;
        for (const m of members.slice(1)) {
            const off = renditions[m].segments.slice(0, count).findIndex((s, i) => Math.abs(s.durationS - reference[i].durationS) > 0.05);
            if (off >= 0) throw new Error(`${id}: group "${group}" is not aligned: ${m} segment ${off} lasts ${renditions[m].segments[off].durationS} s, ${members[0]} ${reference[off].durationS} s`);
        }
        for (const m of members) {
            const r = renditions[m];
            if (r.segments.length > count) {
                r.segments = r.segments.slice(0, count);
                r.loopDurationS = Math.round(r.segments.reduce((sum, s) => sum + s.durationS, 0) * 1e6) / 1e6;
                const steps = segmentSteps.get(r);
                if (steps) r.continuitySteps = sumSteps(steps.slice(0, count));
            }
        }
    }

    const damageDir = await stage(dir, "damage", `${mezzKey}:damage:${damageCount}:${heights.join(",")}`, log, async scratch => {
        const ts = renditions["ts"], alt = renditions["ts-alt"], fm = renditions["fmp4"];
        for (let i = 0; i < Math.min(damageCount, ts.segments.length); i++) {
            const data = readFileSync(join(dir, ts.dir, ts.segments[i].file));
            writeFileSync(join(scratch, `ts-single-frame-${i}.ts`), truncateToFirstFrame(data));
        }
        for (let i = 0; i < Math.min(damageCount, fm.segments.length); i++) {
            const data = readFileSync(join(dir, fm.dir, fm.segments[i].file));
            const damaged = insertZeroSizeSample(data, fm.tracks!);
            if (damaged) writeFileSync(join(scratch, `fmp4-zero-size-sample-${i}.m4s`), damaged);
        }
        writeFileSync(join(scratch, "zero-byte.bin"), Buffer.alloc(0));
        if (ts.segments.length > 1) {
            writeFileSync(join(scratch, "ts-resolution-boundary.ts"), Buffer.concat([
                readFileSync(join(dir, ts.dir, ts.segments[0].file)),
                readFileSync(join(dir, alt.dir, alt.segments[1].file)),
            ]));
        }
    });
    const damage: DamageEntry[] = readdirSync(damageDir).filter(n => !n.startsWith(".")).sort().map(name => {
        const data = readFileSync(join(damageDir, name));
        const index = name.match(/-(\d+)\./)?.[1];
        const kind: DamageEntry["kind"] = name.startsWith("ts-single-frame") ? "single-frame"
            : name.startsWith("fmp4-zero-size") ? "zero-size-sample"
            : name.startsWith("zero-byte") ? "zero-byte" : "resolution-boundary";
        const from = kind === "single-frame" ? `ts/${renditions["ts"].segments[Number(index)].file}`
            : kind === "zero-size-sample" ? `fmp4/${renditions["fmp4"].segments[Number(index)].file}`
            : kind === "resolution-boundary" ? `ts/${renditions["ts"].segments[0].file}+ts-alt/${renditions["ts-alt"].segments[1].file}`
            : undefined;
        return { kind, file: `damage/${name}`, bytes: data.length, sha256: sha256(data), ...(from ? { from } : {}) };
    });

    const manifest: SourceManifest = {
        version: MANIFEST_VERSION, id, input, params: { minutes, maxHeight }, videoCopied: copyVideo,
        renditions, groups, damage,
    };
    const manifestPath = join(dir, "manifest.json");
    const text = JSON.stringify(manifest, null, 2) + "\n";
    if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== text) writeJsonDurable(manifestPath, manifest);
    return manifest;
}
