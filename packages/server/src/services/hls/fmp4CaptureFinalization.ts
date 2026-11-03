import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseNativeMediaPlaylist, type NativeMediaSegment } from "shared";
import type { FinalizationCheckpointStore } from "./finalizationCheckpointStore.js";
import type { MediaIntegrityWarning } from "./mediaIntegrityFinalizer.js";
import { assertCaptureSamplesPreserved, avcNals, initializationAtLevel, readAvcInitialization, readCaptureChunks, splitCaptureChunk,
    type AvcInitialization, type CaptureChunk } from "./fmp4Samples.js";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
interface Source { name: string; size: number; mtime: number; ino: number; sha: string }
interface Output { name: string; sha: string; size: number }
interface Journal {
    version: 1; phase: "prepared" | "published"; originalPlaylist: string; candidatePlaylist: string;
    sources: Source[]; outputs: Output[]; preservedNames: string[]; splitNames: string[]; corrections: number;
}
export interface Fmp4CaptureResult { warnings: MediaIntegrityWarning[]; preservedNames: string[]; changed: boolean }
const unchanged = (): Fmp4CaptureResult => ({ warnings: [], preservedNames: [], changed: false });
function journalKey(folder: string): string {
    const parent = path.dirname(path.resolve(folder));
    const logical = path.basename(parent) === ".pending" ? path.join(path.dirname(parent), path.basename(folder)) : path.resolve(folder);
    return "lossless-fmp4-capture-v1:" + hash(logical);
}
async function syncDirectory(folder: string): Promise<void> {
    const handle = await fs.open(folder, "r"); try { await handle.sync(); } finally { await handle.close(); }
}
async function exclusive(folder: string, name: string, bytes: Buffer): Promise<void> {
    const temporary = path.join(folder, `.fmp4-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        try { await fs.link(temporary, path.join(folder, name)); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const target = path.join(folder, name);
            if (!(await fs.lstat(target)).isFile() || hash(await fs.readFile(target)) !== hash(bytes)) throw new Error("Generated split file conflicts with existing bytes");
        }
    } finally { await fs.unlink(temporary).catch(() => undefined); }
}

function finding(journal: Journal): MediaIntegrityWarning[] {
    return journal.splitNames.length ? [{ kind: "decoder-boundary-split",
        message: `losslessly split ${journal.splitNames.length} mixed AVC fragment(s) at IDR configuration boundaries; original files retained`, names: journal.splitNames }] : [];
}
async function verifyOutputs(folder: string, journal: Journal): Promise<void> {
    for (const file of journal.outputs) {
        if (hash(await fs.readFile(path.join(folder, file.name))) !== file.sha) throw new Error("Published split output is missing or changed");
    }
}
async function verifySources(folder: string, sources: Source[]): Promise<void> {
    for (const source of sources) {
        const stat = await fs.lstat(path.join(folder, source.name));
        if (!stat.isFile() || stat.size !== source.size || stat.mtimeMs !== source.mtime || stat.ino !== source.ino) throw new Error("Captured source changed during lossless finalization");
    }
}
interface PlannedSegment {
    source: NativeMediaSegment; name: string; map: string; boundary: boolean;
    start: number; end: number; duration: number;
}
function clock(chunks: CaptureChunk[]): { start: number; end: number } {
    const video = chunks.flatMap(c => c.runs.filter(r => r.track.kind === "vide").flatMap(r => r.samples.map(s => ({
        start: (s.dts + s.cto) / r.track.scale, end: (s.dts + s.cto + s.duration) / r.track.scale }))));
    const all = chunks.flatMap(c => c.runs.flatMap(r => r.samples.map(s => ({ start: (s.dts + s.cto) / r.track.scale,
        end: (s.dts + s.cto + s.duration) / r.track.scale }))));
    return { start: Math.min(...(video.length ? video : all).map(s => s.start)), end: Math.max(...all.map(s => s.end)) };
}
// The only rewrite is finalized capture metadata and generated sample-copy
// fragments. Original media/init files remain byte-identical, and the original
// playlist plus a restart journal are durable before any publication.
export async function finalizeFmp4Capture(folder: string, store?: FinalizationCheckpointStore): Promise<Fmp4CaptureResult> {
    if (!store) return unchanged();
    const playlistPath = path.join(folder, "playlist.m3u8"), text = await fs.readFile(playlistPath, "utf8");
    if (!text.includes("#EXT-X-MAP:") || !text.split(/\r?\n/).includes("#EXT-X-ENDLIST")) return unchanged();
    const key = journalKey(folder), old = store.getMeta<Journal>(key);
    if (old) {
        if (text === old.candidatePlaylist) {
            await verifyOutputs(folder, old);
            if (old.phase !== "published") store.setMeta(key, { ...old, phase: "published" });
            return { warnings: finding(old), preservedNames: old.preservedNames, changed: false };
        }
        if (text !== old.originalPlaylist) return { ...unchanged(), warnings: [{ kind: "decoder-boundary-unrepaired", message: "Playlist changed after a lossless capture repair; left unchanged" }] };
        await verifySources(folder, old.sources);
    }
    const playlist = parseNativeMediaPlaylist(text);
    const sources: Source[] = [], outputs = new Map<string, Buffer>(), preserved = new Set<string>(), splitNames: string[] = [];
    const initializations = new Map<string, AvcInitialization>(); let active: Buffer | null = null, previousMap: string | null = null;
    const planned: PlannedSegment[] = [];
    const read = async (name: string) => {
        const filename = path.join(folder, name), stat = await fs.lstat(filename);
        if (!stat.isFile()) throw new Error("Only unchanged regular capture files can be split");
        const bytes = await fs.readFile(filename);
        sources.push({ name, size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, sha: hash(bytes) }); return bytes;
    };
    try {
        for (const segment of playlist.segments) {
            if (!segment.mapUri) return unchanged();
            if (segment.mapLine?.includes("BYTERANGE=")) throw new Error("Unsupported ranged initialization map");
            let init = initializations.get(segment.mapUri);
            if (!init) {
                const value = readAvcInitialization(await read(segment.mapUri)); if (!value) return unchanged();
                init = value; initializations.set(segment.mapUri, init);
            }
            if (previousMap !== segment.mapUri || segment.metadata.includes("#EXT-X-DISCONTINUITY")) active = init.sps;
            previousMap = segment.mapUri;
            const bytes = await read(segment.name), chunks = readCaptureChunks(bytes, init), groups: { sps: Buffer; chunks: CaptureChunk[] }[] = [];
            let pending: CaptureChunk[] = [], groupSps = active!;
            const flush = () => { if (pending.length) groups.push({ sps: groupSps, chunks: pending }); pending = []; };
            for (const originalChunk of chunks) {
                let remaining = originalChunk;
                const video = originalChunk.runs.find(r => r.track.id === init!.video);
                for (const sample of video?.samples ?? []) {
                    const nals = avcNals(sample, init.lengthBytes); let next = active!, seenPicture = false;
                    for (const nal of nals) {
                        const type = nal[0] & 31;
                        if (type === 7 && !nal.equals(next)) {
                            if (seenPicture) throw new Error("AVC configuration changes inside one coded sample");
                            initializationAtLevel(init, nal); next = nal;
                        }
                        if (type === 8 && !nal.equals(init.pps)) throw new Error("Unsupported PPS change");
                        if (type >= 1 && type <= 5) seenPicture = true;
                    }
                    if (next.equals(active!)) continue;
                    if (!nals.some(n => (n[0] & 31) === 5) || sample.flags & 0x10000) throw new Error("AVC change is not at an indexed IDR sample");
                    const first = remaining.runs.find(r => r.track.id === init!.video)!.samples[0];
                    if (sample !== first) {
                        const parts = splitCaptureChunk(remaining, init.video, sample.dts);
                        pending.push(parts[0]); remaining = parts[1];
                    }
                    flush(); active = next; groupSps = active;
                }
                pending.push(remaining);
            }
            flush();
            const split = groups.length > 1;
            if (split) assertCaptureSamplesPreserved(chunks,
                readCaptureChunks(Buffer.concat(groups.flatMap(g => g.chunks.map(c => c.bytes))), init));
            if (split) { splitNames.push(segment.name); preserved.add(segment.name); }
            for (const [part, group] of groups.entries()) {
                let map = segment.mapUri;
                if (!group.sps.equals(init.sps)) {
                    const initialization = initializationAtLevel(init, group.sps); map = `init_split_${hash(initialization).slice(0, 16)}.mp4`;
                    outputs.set(map, initialization); preserved.add(segment.mapUri);
                }
                const name = split ? `_split_${hash(bytes).slice(0, 16)}_${part}.ts` : segment.name;
                if (split) outputs.set(name, Buffer.concat(group.chunks.map(c => c.bytes)));
                const timing = clock(group.chunks);
                planned.push({ source: segment, name, map, boundary: part > 0 || segment.metadata.includes("#EXT-X-DISCONTINUITY"),
                    ...timing, duration: segment.durationSeconds });
            }
        }
    } catch (error) {
        if (["EIO", "EACCES", "EPERM", "ENOSPC", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        return { ...unchanged(), warnings: [{ kind: "decoder-boundary-unrepaired", message: `Capture layout cannot be losslessly finalized: ${(error as Error).message}` }] };
    }
    let corrections = 0;
    for (const [index, segment] of planned.entries()) {
        const next = planned[index + 1];
        // Across a generated configuration cut the clocks have not reset. Across
        // a provider cut/map change use the actual end of this source run.
        const continuous = next && next.source.mapUri === segment.source.mapUri
            && (!next.source.metadata.includes("#EXT-X-DISCONTINUITY") || next.source === segment.source);
        const duration = continuous && next.start > segment.start ? next.start - segment.start : segment.end - segment.start;
        if (!Number.isFinite(duration) || duration <= 0) return unchanged();
        if (Math.abs(duration - segment.duration) > .0000005) corrections++;
        segment.duration = duration;
    }
    const lines = playlist.header.map(line => line.startsWith("#EXT-X-TARGETDURATION:")
        ? `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(...planned.map(s => s.duration))))}` : line);
    let map: string | null = null;
    for (const segment of planned) {
        if (segment.boundary || map !== null && map !== segment.map) lines.push("#EXT-X-DISCONTINUITY");
        if (map !== segment.map) { lines.push(`#EXT-X-MAP:URI="${segment.map}"`); map = segment.map; }
        if (segment.name === segment.source.name || planned.find(s => s.source === segment.source) === segment) {
            lines.push(...segment.source.metadata.filter(line => !line.startsWith("#EXTINF:") && line !== "#EXT-X-DISCONTINUITY"));
        }
        lines.push(`#EXTINF:${segment.duration.toFixed(9)},`, segment.name);
    }
    lines.push("#EXT-X-ENDLIST", ""); const candidate = lines.join("\n");
    if (!outputs.size && !corrections) return unchanged();
    const journal: Journal = { version: 1, phase: "prepared", originalPlaylist: text, candidatePlaylist: candidate, sources,
        outputs: [...outputs].map(([name, bytes]) => ({ name, sha: hash(bytes), size: bytes.length })),
        preservedNames: [...preserved], splitNames, corrections };
    store.setMeta(key, journal);
    for (const [name, bytes] of outputs) await exclusive(folder, name, bytes);
    await syncDirectory(folder); await verifySources(folder, sources);
    if (await fs.readFile(playlistPath, "utf8") !== text) throw new Error("Playlist changed before lossless finalization publication");
    const temporary = path.join(folder, `.playlist-${randomUUID()}.tmp`), handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(candidate); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, playlistPath); await syncDirectory(folder);
    store.setMeta(key, { ...journal, phase: "published" });
    return { warnings: finding(journal), preservedNames: journal.preservedNames, changed: true };
}
