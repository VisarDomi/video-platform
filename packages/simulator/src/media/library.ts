// Read side of the media cache: manifests, raw files and the bytes actually
// served for a segment (timestamps moved for the loop, damage applied).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { insertZeroSizeSample, shiftFragment } from "./fmp4.js";
import { MANIFEST_VERSION, type RenditionManifest, type SourceManifest } from "./manifest.js";
import { advanceContinuity, shiftTimestamps, truncateToFirstFrame } from "./ts.js";

export type DamageKind = "single-frame" | "zero-byte" | "zero-size-sample" | "truncated";

export interface SegmentRequest {
    source: string;
    rendition: string;
    /** Index into the rendition's segment list. */
    index: number;
    /** How many whole passes of the source came before this segment. */
    loop: number;
    damage?: DamageKind | null;
}

class Lru<V> {
    private readonly map = new Map<string, V>();
    private weight = 0;
    constructor(private readonly maxWeight: number, private readonly weigh: (v: V) => number) {}
    get(key: string): V | undefined {
        const v = this.map.get(key);
        if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
        return v;
    }
    set(key: string, v: V): void {
        if (this.map.has(key)) return;
        this.map.set(key, v);
        this.weight += this.weigh(v);
        for (const [k, old] of this.map) {
            if (this.weight <= this.maxWeight || this.map.size <= 1) break;
            this.map.delete(k);
            this.weight -= this.weigh(old);
        }
    }
}

export class MediaLibrary {
    readonly sources = new Map<string, SourceManifest>();
    private readonly files = new Lru<Buffer>(256 * 1024 * 1024, b => b.length);
    private readonly served = new Lru<Buffer>(256 * 1024 * 1024, b => b.length);

    constructor(readonly root: string, manifests: SourceManifest[]) {
        for (const m of manifests) this.sources.set(m.id, m);
    }

    static load(root: string): MediaLibrary {
        if (!existsSync(root)) throw new Error(`media cache ${root} does not exist; run "simulator prep" first`);
        const manifests: SourceManifest[] = [];
        for (const name of readdirSync(root).sort()) {
            const path = join(root, name, "manifest.json");
            if (!existsSync(path)) continue;
            const manifest = JSON.parse(readFileSync(path, "utf8")) as SourceManifest;
            if (manifest.version !== MANIFEST_VERSION) throw new Error(`${path}: manifest version ${manifest.version}, expected ${MANIFEST_VERSION}`);
            manifests.push(manifest);
        }
        if (manifests.length === 0) throw new Error(`media cache ${root} has no prepared sources`);
        return new MediaLibrary(root, manifests);
    }

    ids(): string[] {
        return [...this.sources.keys()];
    }

    source(id: string): SourceManifest {
        const s = this.sources.get(id);
        if (!s) throw new Error(`unknown media source "${id}"`);
        return s;
    }

    rendition(source: string, rendition: string): RenditionManifest {
        const r = this.source(source).renditions[rendition];
        if (!r) throw new Error(`source "${source}" has no rendition "${rendition}"`);
        return r;
    }

    group(source: string, group: string): RenditionManifest[] {
        const ids = this.source(source).groups[group];
        if (!ids) throw new Error(`source "${source}" has no group "${group}"`);
        return ids.map(id => this.rendition(source, id));
    }

    private file(source: string, rel: string): Buffer {
        const key = `${source}/${rel}`;
        let data = this.files.get(key);
        if (!data) {
            data = readFileSync(join(this.root, source, rel));
            this.files.set(key, data);
        }
        return data;
    }

    initBytes(source: string, rendition: string): Buffer {
        const r = this.rendition(source, rendition);
        if (!r.init) throw new Error(`rendition "${rendition}" has no init segment`);
        return this.file(source, `${r.dir}/${r.init.file}`);
    }

    /** The exact bytes served for a segment: deterministic for a request. */
    segmentBytes(req: SegmentRequest): Buffer {
        const key = `${req.source}/${req.rendition}/${req.index}/${req.loop}/${req.damage ?? ""}`;
        const cached = this.served.get(key);
        if (cached) return cached;
        const r = this.rendition(req.source, req.rendition);
        const entry = r.segments[req.index];
        if (!entry) throw new RangeError(`segment ${req.index} out of range for ${req.rendition}`);
        const raw = this.file(req.source, `${r.dir}/${entry.file}`);
        const shiftS = req.loop * r.loopDurationS;
        // A later pass continues the timestamps, continuity counters and
        // fragment numbers of the pass before, like an unbroken live encoder.
        let data = r.format === "ts"
            ? advanceContinuity(shiftTimestamps(raw, Math.round(shiftS * 90000)), r.continuitySteps ?? {}, req.loop)
            : shiftFragment(raw, shiftS, r.tracks ?? [], req.loop * r.segments.length);
        switch (req.damage ?? null) {
            case null: break;
            case "zero-byte": data = Buffer.alloc(0); break;
            case "truncated": data = Buffer.from(data.subarray(0, Math.floor(data.length / 2 / 188) * 188 || Math.floor(data.length / 2))); break;
            case "single-frame": if (r.format === "ts") data = truncateToFirstFrame(data); break;
            case "zero-size-sample": if (r.format === "fmp4") data = insertZeroSizeSample(data, r.tracks ?? []) ?? data; break;
        }
        this.served.set(key, data);
        return data;
    }
}
