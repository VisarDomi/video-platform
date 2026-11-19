// What the two destinations share: uploaded media on disk, probing it,
// each video's timeline (processing, published or failed, removed) as a pure
// function of the scenario and the clock, quality tiers by source size, and
// the rendition files served for them.
//
// Only facts are stored (who uploaded what, when, with which metadata); every
// later state is computed from them at the instant asked about, so a clock
// jump or a restart never leaves a video "stuck" in a stale state.
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fsyncDir, writeFileDurable } from "../fsutil.js";
import { sha256File } from "../http/files.js";
import { ffmpeg, probe } from "../media/ffmpeg.js";
import type { ProcessingRule, RemovalRule, VideoSelector } from "../scenario/hosts.js";
import type { StateStore } from "../sim.js";

export interface MediaFacts {
    width: number;
    height: number;
    durationS: number;
}

export interface StoredVideo {
    id: string;
    account: string;
    /** 1-based creation order within the account. */
    nth: number;
    createdAt: number;
    /** As submitted. */
    title: string;
    description: string;
    tags: string[];
    category: string | null;
    visibility: "public" | "private";
    /** As stored by the site (words replaced). */
    storedTitle: string;
    storedDescription: string;
    notices: string[];
    limitedReason: string | null;
    /** null until the media arrived (api-host creates the video first). */
    media: { file: string; bytes: number; sha256: string; facts: MediaFacts | null; at: number } | null;
    /** api-host: the client's reference (idempotency). */
    clientRef?: string | null;
    /** Processing fails for this reason whatever the rules say (e.g. a duration limit). */
    failureReason?: string | null;
    /** Removed through the control API or deleted by the client. */
    removedAt?: number | null;
    removedBy?: "client" | "control" | null;
    removalReason?: string | null;
}

export interface TimelineSpec {
    epochMs: number;
    processingS: number;
    processingRules: ProcessingRule[];
    removals: RemovalRule[];
}

export interface Timeline {
    /** When processing ends (null: the media has not arrived). */
    processedAt: number | null;
    outcome: "ready" | "failed";
    /** A failed video that publishes later. */
    recoversAt: number | null;
    removedAt: number | null;
    removalKind: "removed" | "rejected" | null;
    removalReason: string | null;
}

export type VideoState = "uploading" | "processing" | "ready" | "failed" | "removed" | "rejected";

function selects(rule: VideoSelector, video: StoredVideo): boolean {
    if (rule.account !== undefined && rule.account !== video.account) return false;
    if (rule.nth !== undefined && rule.nth !== video.nth) return false;
    if (rule.titleMatches !== undefined && !new RegExp(rule.titleMatches, "i").test(video.title)) return false;
    if (rule.shorterThanS !== undefined && !(video.media?.facts && video.media.facts.durationS < rule.shorterThanS)) return false;
    return true;
}

export function timeline(video: StoredVideo, spec: TimelineSpec): Timeline {
    const rule = spec.processingRules.find(r => selects(r, video));
    const facts = video.media?.facts ?? null;
    const processedAt = video.media ? video.media.at + (rule?.processingS ?? spec.processingS) * 1000 : null;
    // Media nobody can decode, or that breaks a limit, always fails.
    const outcome = facts === null || video.failureReason ? "failed" : rule?.outcome ?? "ready";
    const recoversAt = outcome === "failed" && facts !== null && !video.failureReason && rule?.recoverAfterS !== undefined && processedAt !== null
        ? processedAt + rule.recoverAfterS * 1000 : null;
    let removedAt: number | null = video.removedAt ?? null;
    let removalKind: Timeline["removalKind"] = removedAt !== null ? "removed" : null;
    let removalReason = video.removalReason ?? null;
    for (const r of spec.removals) {
        if (!selects(r, video)) continue;
        let at: number | null;
        if (r.at !== undefined && r.afterS !== undefined) at = Math.max(spec.epochMs + r.at * 1000, video.createdAt + r.afterS * 1000);
        else if (r.at !== undefined) at = video.createdAt < spec.epochMs + r.at * 1000 ? spec.epochMs + r.at * 1000 : null;
        else at = video.createdAt + r.afterS! * 1000;
        if (at !== null && (removedAt === null || at < removedAt)) {
            removedAt = at;
            removalKind = r.kind ?? "removed";
            removalReason = r.reason ?? null;
        }
    }
    return { processedAt, outcome, recoversAt, removedAt, removalKind, removalReason };
}

export function stateAt(video: StoredVideo, spec: TimelineSpec, t: number): VideoState {
    const tl = timeline(video, spec);
    if (tl.removedAt !== null && t >= tl.removedAt) return tl.removalKind === "rejected" ? "rejected" : "removed";
    if (tl.processedAt === null) return "uploading";
    if (t < tl.processedAt) return "processing";
    if (tl.outcome === "failed" && (tl.recoversAt === null || t < tl.recoversAt)) return "failed";
    return "ready";
}

// ---- quality tiers ----

export interface Tier {
    height: number;
    label: string;
    width: number;
    /** Scaled size actually served (fits the tier's 16:9 box, never upscaled). */
    outWidth: number;
    outHeight: number;
}

const TIERS: Array<{ height: number; label: string }> = [
    { height: 1080, label: "1080p FHD" }, { height: 720, label: "720p HD" }, { height: 480, label: "480p" }, { height: 360, label: "360p" },
];

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Renditions offered for a source, best first. The full-HD tier needs a
 * source at least 1920 wide; the others need the source to reach the tier's
 * width or height; the lowest tier is always offered. Each tier's picture is
 * the source scaled to fit a 16:9 box of the tier's height (a portrait
 * 1080x1920 source tops out at 406x720).
 */
export function qualityTiers(facts: MediaFacts): Tier[] {
    const out: Tier[] = [];
    for (const [i, t] of TIERS.entries()) {
        const boxW = Math.round(t.height * 16 / 9);
        const lowest = i === TIERS.length - 1;
        const offered = t.height === 1080 ? facts.width >= 1920 : facts.width >= boxW || facts.height >= t.height || lowest;
        if (!offered) continue;
        const scale = Math.min(1, boxW / facts.width, t.height / facts.height);
        out.push({ height: t.height, label: t.label, width: boxW, outWidth: even(facts.width * scale), outHeight: even(facts.height * scale) });
    }
    return out;
}

// ---- media on disk ----

/** Uploaded parts and assembled media of one site, durable when there is a state directory. */
export class MediaStore {
    readonly dir: string;
    private readonly temporary: boolean;
    private readonly renditions = new Map<string, Promise<string>>();

    constructor(store: StateStore, site: string) {
        const durable = store.blobDir(site);
        this.temporary = durable === null;
        this.dir = durable ?? mkdtempSync(join(os.tmpdir(), `sim-${site}-`));
        mkdirSync(this.dir, { recursive: true });
    }

    path(...parts: string[]): string { return join(this.dir, ...parts); }

    /** Writes a whole file durably (temp, fsync, rename, fsync dir). */
    put(rel: string, data: Uint8Array): string {
        const file = this.path(rel);
        writeFileDurable(file, data);
        return file;
    }

    /**
     * Writes `data` at offset `size` (the bytes acknowledged so far) and fsyncs;
     * returns the new size. Bytes past `size` (written before a crash, never
     * acknowledged) are cut off first, so the file always equals the
     * acknowledged prefix plus this piece.
     */
    append(rel: string, data: Uint8Array, size: number): number {
        const file = this.path(rel);
        mkdirSync(join(file, ".."), { recursive: true });
        const created = !existsSync(file);
        const fd = openSync(file, created ? "w" : "r+");
        try {
            ftruncateSync(fd, size);
            let written = 0;
            while (written < data.length) written += writeSync(fd, data, written, data.length - written, size + written);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        if (created) fsyncDir(join(file, ".."));
        return size + data.length;
    }

    /** Concatenates part files into one durable file. */
    assemble(parts: string[], rel: string): string {
        const file = this.path(rel);
        mkdirSync(join(file, ".."), { recursive: true });
        const tmp = `${file}.partial`;
        const fd = openSync(tmp, "w");
        try {
            for (const p of parts) writeSync(fd, readFileSync(p)); // parts are at most a few MiB
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(tmp, file);
        fsyncDir(join(file, ".."));
        return file;
    }

    remove(rel: string): void {
        rmSync(this.path(rel), { recursive: true, force: true });
    }

    async facts(file: string): Promise<{ sha256: string; facts: MediaFacts | null }> {
        const digest = await sha256File(file);
        try {
            const p = await probe(file);
            if (!p.video || !p.video.width || !p.video.height) return { sha256: digest, facts: null };
            return { sha256: digest, facts: { width: p.video.width, height: p.video.height, durationS: Math.round(p.durationS * 1000) / 1000 } };
        } catch {
            return { sha256: digest, facts: null };
        }
    }

    /**
     * The file served for a tier: the upload itself when it already has the
     * tier's size, else a scaled copy made once (at the lowest CPU priority).
     */
    rendition(video: StoredVideo, tier: Tier): Promise<string> {
        const media = video.media!;
        if (media.facts && media.facts.width === tier.outWidth && media.facts.height === tier.outHeight) return Promise.resolve(media.file);
        const rel = join("renditions", `${video.id}-${tier.height}.mp4`);
        const file = this.path(rel);
        let pending = this.renditions.get(file);
        if (!pending) {
            pending = (async () => {
                if (existsSync(file)) return file;
                mkdirSync(join(file, ".."), { recursive: true });
                const tmp = `${file}.partial.mp4`;
                await ffmpeg(["-i", media.file, "-map", "0:v:0", "-map", "0:a:0?", "-vf", `scale=${tier.outWidth}:${tier.outHeight}`,
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-threads", "2", "-c:a", "aac", "-b:a", "96k",
                    "-movflags", "+faststart", tmp]);
                const fd = openSync(tmp, "r");
                try { fsyncSync(fd); } finally { closeSync(fd); }
                renameSync(tmp, file);
                fsyncDir(join(file, ".."));
                return file;
            })();
            pending.catch(() => this.renditions.delete(file));
            this.renditions.set(file, pending);
        }
        return pending;
    }

    close(): void {
        if (this.temporary) rmSync(this.dir, { recursive: true, force: true });
    }
}

export function slugify(title: string): string {
    const slug = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
    return slug || "video";
}

/** Applies banned-word replacements; returns the stored text and the words hit. */
export function replaceWords(text: string, words: Array<{ word: string; replacement?: string }>): { text: string; hits: string[] } {
    const hits: string[] = [];
    let out = text;
    for (const w of words) {
        const re = new RegExp(`\\b${w.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
        if (re.test(out)) {
            hits.push(w.word);
            out = out.replace(re, w.replacement ?? "*".repeat(w.word.length));
        }
    }
    return { text: out, hits };
}

export function containsWord(text: string, word: string): boolean {
    return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}
