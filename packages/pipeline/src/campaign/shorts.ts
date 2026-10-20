import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { journalPriority, policyForUploadProvider } from "shared";
import type { PipelineConfig } from "../config.js";
import type { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { ShortPart } from "../domain/shorts.js";
import type { ProductionArtifactPart, Recording } from "../domain/types.js";
import type { TargetCatalogResolver } from "../provenance/targetResolver.js";
import { inspectFinalizedRecording } from "../discovery/inspectRecording.js";
import { readRecordingFinalization } from "../discovery/recordingFinalization.js";
import { analyzeRecordingResolution, deriveResolutionPlaylist, planRecordingShapes } from "../stages/resolutionPolicy.js";
import { syncFile } from "../stages/durableArtifact.js";
import { captureKeyFromFolderName } from "./selectCandidate.js";

const scanTimes = new Map<string, number>();
const SCAN_INTERVAL_MS = 5 * 60_000;
const warned = new Map<string, number>();
function deferred(key: string, error: unknown): void {
    if (Date.now() - (warned.get(key) ?? 0) < 60 * 60_000) return;
    warned.set(key, Date.now());
    console.warn(journalPriority("warn", 2) + JSON.stringify({ event: "short-analysis-deferred", recordingId: key, reason: String(error) }));
}
async function syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
}

export function compatibleShortGroups(parts: readonly ShortPart[], minimumSeconds: number): ShortPart[][] {
    const pending = [...parts].filter(p => !p.batchId && !p.verified)
        .sort((a, b) => a.recordingId.localeCompare(b.recordingId) || a.part.localeCompare(b.part, undefined, { numeric: true }));
    const groups: ShortPart[][] = [];
    while (pending.length) {
        const first = pending.shift()!;
        const group = [first];
        const selected: number[] = [];
        let low = first.aspectRatio, high = low, duration = first.durationSeconds;
        for (let index = 0; index < pending.length && duration < minimumSeconds; ) {
            const next = pending[index];
            const nextLow = Math.min(low, next.aspectRatio), nextHigh = Math.max(high, next.aspectRatio);
            if (next.streamerKey !== first.streamerKey || next.destinationProvider !== first.destinationProvider
                || nextHigh / nextLow - 1 > 0.01) { index++; continue; }
            selected.push(index++);
            group.push(next);
            low = nextLow; high = nextHigh; duration += next.durationSeconds;
        }
        if (duration >= minimumSeconds) {
            for (const index of selected.reverse()) pending.splice(index, 1);
            groups.push(group);
        }
    }
    return groups;
}

export async function poolRecordingPart(database: PipelineDatabase, recording: Recording,
    destinationProvider: "porntrex", selectedPart?: ProductionArtifactPart, actualSeconds?: number): Promise<number> {
    const provenance = database.getProvenance(recording.id);
    if (!provenance) return 0;
    const analysis = await analyzeRecordingResolution(recording.playlistPath);
    const plan = planRecordingShapes(analysis);
    const groups = [...plan.upload, ...plan.manual].sort((a, b) => a.ordinal - b.ordinal);
    const parts: Array<Omit<ShortPart, "batchId" | "verified">> = [];
    for (const group of groups) {
        if (selectedPart && group.part !== selectedPart) continue;
        parts.push({ recordingId: recording.id, part: group.part,
            sourceFingerprint: recording.sourceFingerprint,
            streamerKey: provenance.streamerId ? `${recording.provider}:${provenance.streamerId}`
                : `unresolved:${recording.provider}:${provenance.observedIdentifier}`, destinationProvider,
            aspectRatio: group.displayAspectRatio, durationSeconds: Math.min(group.durationSeconds, actualSeconds ?? Infinity),
            playlist: deriveResolutionPlaylist(analysis, group.indexes) });
    }
    if (selectedPart && parts.length === 0) throw new Error(`Cannot locate short shape ${selectedPart} in its source`);
    database.saveShortParts(parts);
    return parts.length;
}

export async function buildShortBatch(database: PipelineDatabase, config: PipelineConfig,
    parts: readonly ShortPart[], minimumSeconds: number, now = new Date()): Promise<Recording> {
    const first = database.get(parts[0].recordingId);
    if (!first) throw new Error("Joined short has no original recording");
    const provenance = database.getProvenance(first.id);
    if (!provenance?.streamerId) throw new Error("Joined shorts require a resolved streamer");
    const signature = JSON.stringify(parts.map(p => [p.recordingId, p.part, p.sourceFingerprint, p.destinationProvider, p.durationSeconds]));
    const hash = createHash("sha256").update(signature).digest("hex").slice(0, 12);
    // Preserve capture date/name, leaving room for generated artifact suffixes
    // even when an original streamer label is long or uses multibyte text.
    const batchId = `${Array.from(first.id).slice(0, 50).join("")} joined-${hash}`;
    const parent = path.join(config.stagingRoot, "joined-sources");
    const target = path.join(parent, batchId);
    await fs.mkdir(parent, { recursive: true });
    if (await fs.realpath(parent) !== path.resolve(parent)) throw new Error("Joined source root cannot contain symlinks");
    const temporary = path.join(parent, `.join-${randomUUID()}`);
    await fs.mkdir(temporary);
    const body: string[] = [];
    let longest = 1;
    try {
        for (let position = 0; position < parts.length; position++) {
            const part = parts[position];
            const member = database.get(part.recordingId);
            if (!member || member.provider !== first.provider || member.sourceFingerprint !== part.sourceFingerprint) {
                throw new Error("Joined source identity changed");
            }
            const current = await inspectFinalizedRecording(member.sourcePath, member.provider, member.sourceKind);
            if (current.status !== "finalized" || current.recording.sourceFingerprint !== part.sourceFingerprint
                || !readRecordingFinalization(config.finalizationDatabasePath, member.sourcePath,
                    await fs.readFile(member.playlistPath, "utf8"))) throw new Error("Joined member lost its exact server checkpoint");
            if (position) body.push("#EXT-X-DISCONTINUITY");
            const links = new Map<string, string>();
            const link = async (uri: string) => {
                const absolute = path.resolve(member.sourcePath, uri);
                if (path.dirname(absolute) !== path.resolve(member.sourcePath)) throw new Error("Unsafe joined media reference");
                let name = links.get(absolute);
                if (!name) {
                    name = `${position}_${links.size}${path.extname(absolute)}`;
                    await fs.symlink(absolute, path.join(temporary, name));
                    links.set(absolute, name);
                }
                return name;
            };
            for (const raw of part.playlist.split(/\r?\n/)) {
                const line = raw.trim();
                if (!line || /^#EXT(?:M3U|-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE|PLAYLIST-TYPE|ENDLIST|INDEPENDENT-SEGMENTS))(?::|$)/.test(line)) continue;
                if (line.startsWith("#EXTINF:")) longest = Math.max(longest, Math.ceil(Number.parseFloat(line.slice(8))));
                const reference = line.match(/\bURI="([^"]+)"/);
                if (reference) body.push(line.replace(reference[0], `URI="${await link(reference[1])}"`));
                else body.push(line.startsWith("#") ? line : await link(line));
            }
        }
        const playlist = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${longest}`,
            "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", ...body, "#EXT-X-ENDLIST", ""].join("\n");
        await fs.writeFile(path.join(temporary, "playlist.m3u8"), playlist);
        await fs.writeFile(path.join(temporary, "join.json"), JSON.stringify({ signature, members: parts.map(p => [p.recordingId, p.part]) }));
        await syncFile(path.join(temporary, "playlist.m3u8"));
        await syncFile(path.join(temporary, "join.json"));
        await syncDirectory(temporary);
        try {
            const existing = JSON.parse(await fs.readFile(path.join(target, "join.json"), "utf8")) as { signature?: string };
            if (existing.signature !== signature) throw new Error("Joined input directory conflicts with existing media");
            const current = await inspectFinalizedRecording(target, first.provider, "edited");
            const expected = await inspectFinalizedRecording(temporary, first.provider, "edited");
            if (current.status !== "finalized" || expected.status !== "finalized"
                || current.recording.sourceFingerprint !== expected.recording.sourceFingerprint) {
                await fs.rm(target, { recursive: true, force: true });
                await fs.rename(temporary, target);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (await fs.lstat(target).catch(() => null)) throw new Error("Unrecognized joined input directory");
            await fs.rename(temporary, target);
        }
        await syncDirectory(parent);
        await syncDirectory(config.stagingRoot);
        const inspection = await inspectFinalizedRecording(target, first.provider, "edited");
        if (inspection.status !== "finalized" || inspection.recording.durationSeconds < minimumSeconds) {
            throw new Error("Joined playlist still falls below the destination minimum");
        }
        const shapePlan = planRecordingShapes(await analyzeRecordingResolution(inspection.recording.playlistPath));
        if (shapePlan.upload.length + shapePlan.manual.length !== 1) throw new Error("Joined inputs have incompatible shapes");
        return database.createShortBatch(inspection.recording, provenance, parts, now);
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

async function ingestShorts(database: PipelineDatabase, config: PipelineConfig, resolver: TargetCatalogResolver,
    provider: "porntrex", minimum: number, now: Date): Promise<number> {
    const authority = new DatabaseSync(config.finalizationDatabasePath, { readOnly: true });
    let checkpoints: Array<{ recording_path: string; report_json: string }>;
    try { checkpoints = authority.prepare("SELECT recording_path, report_json FROM integrity_checkpoints ORDER BY recording_path")
        .all() as unknown as typeof checkpoints; } finally { authority.close(); }
    let registered = 0;
    const providerFilter = database.getCampaignControl().providerFilter;
    for (const checkpoint of checkpoints) {
        const sourcePath = path.resolve(checkpoint.recording_path);
        const root = config.discoveryRoots.find(r => path.resolve(r.path) === path.dirname(sourcePath)
            && r.sourceKind === "edited" && (providerFilter === "all" || r.provider === providerFilter));
        if (!root || !captureKeyFromFolderName(path.basename(sourcePath))) continue;
        const existing = database.getBySourcePath(sourcePath);
        const recoverable = existing?.state === "short_cancelled"
            || existing?.state === "blocked" && existing.blockReason?.includes(`${provider}: skipped_too_short`);
        if (existing && (!recoverable || existing.leaseOwner)) continue;
        if (existing && database.providerRemovals(existing.id).some(r => r.provider === provider)) continue;
        let playlist: string;
        try {
            const report = JSON.parse(checkpoint.report_json) as { status?: string; version?: number };
            if (report.status !== "ready" || report.version !== 2) continue;
            playlist = await fs.readFile(path.join(sourcePath, "playlist.m3u8"), "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) continue;
            throw error;
        }
        const duration = [...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
        if (!(duration > 0 && duration < minimum)) continue;
        const inspection = await inspectFinalizedRecording(sourcePath, root.provider, "edited");
        if (inspection.status !== "finalized" || !readRecordingFinalization(config.finalizationDatabasePath, sourcePath, playlist)) continue;
        const recording = database.discover(inspection.recording, now);
        if (recording.provider !== root.provider || recording.sourcePath !== sourcePath) continue;
        if (existing && recording.sourceFingerprint !== existing.sourceFingerprint) continue;
        const provenance = database.getProvenance(recording.id) ?? await resolver.resolve(inspection.recording, now);
        database.saveProvenance(recording.id, provenance);
        database.waitForShorts(recording.id, provider, now);
        registered++;
    }
    return registered;
}

export async function maintainAutomaticShorts(database: PipelineDatabase, config: PipelineConfig,
    resolver: TargetCatalogResolver, now = new Date()): Promise<{ registered: number; joined: string[] }> {
    const provider = config.uploadProvider ?? database.getActiveUploadProvider();
    const minimum = policyForUploadProvider(provider).minimumDurationSeconds ?? 0;
    let registered = 0;
    if (now.getTime() - (scanTimes.get(config.databasePath) ?? 0) >= SCAN_INTERVAL_MS) {
        if (minimum > 0) registered = await ingestShorts(database, config, resolver, provider, minimum, now);
        scanTimes.set(config.databasePath, now.getTime());
    }
    const waiting = database.list("short_waiting");
    const byStreamer = new Map<string, Recording[]>();
    for (const recording of waiting) {
        if (recording.leaseOwner || database.providerRemovals(recording.id).some(r => r.provider === provider)) continue;
        if (!await fs.access(recording.playlistPath).then(() => true, () => false)) {
            database.discardMissingShort(recording.id, "user removed the pending short source", now);
            continue;
        }
        let provenance = database.getProvenance(recording.id);
        if (!provenance?.streamerId && (!provenance || now.getTime() - Date.parse(provenance.updatedAt) >= 60 * 60_000)) {
            provenance = database.saveProvenance(recording.id, await resolver.resolve(recording, now));
        }
        if (!provenance?.streamerId) continue;
        const key = `${recording.provider}:${provenance.streamerId}`;
        const group = byStreamer.get(key) ?? [];
        group.push(recording); byStreamer.set(key, group);
    }
    for (const [key, recordings] of byStreamer) {
        const ids = new Set(recordings.map(r => r.id));
        const otherPending = database.shortParts().filter(p => !p.batchId && !p.verified && p.streamerKey === key
            && !ids.has(p.recordingId)).reduce((sum, p) => sum + p.durationSeconds, 0);
        if (otherPending + recordings.reduce((sum, r) => sum + r.durationSeconds, 0) < minimum) continue;
        for (const recording of recordings) {
            if (database.shortParts(recording.id).length) continue;
            try { await poolRecordingPart(database, recording, provider); }
            catch (error) { deferred(recording.id, error); }
        }
    }
    const proposed = database.shortParts().filter(p => !p.batchId && !p.verified
        && !p.streamerKey.startsWith("unresolved:")
        && (p.destinationProvider === provider || minimum === 0));
    const pending: ShortPart[] = [];
    const inspected = new Map<string, boolean>();
    for (const part of proposed) {
        if (!inspected.has(part.recordingId)) {
            const recording = database.get(part.recordingId);
            const current = recording && await inspectFinalizedRecording(recording.sourcePath, recording.provider, recording.sourceKind);
            const valid = current?.status === "finalized" && current.recording.sourceFingerprint === part.sourceFingerprint
                && !!readRecordingFinalization(config.finalizationDatabasePath, recording!.sourcePath,
                    await fs.readFile(recording!.playlistPath, "utf8"));
            inspected.set(part.recordingId, valid);
        }
        if (inspected.get(part.recordingId)) pending.push(part);
    }
    const joined: string[] = [];
    for (const parts of compatibleShortGroups(pending, minimum)) {
        try {
            const batch = await buildShortBatch(database, config, parts, minimum, now);
            joined.push(batch.id);
        } catch (error) { deferred(parts.map(p => p.recordingId).join(";"), error); }
    }
    return { registered, joined };
}

export async function cancelInvalidShortBatch(database: PipelineDatabase, config: PipelineConfig,
    id: string, reason: string, now = new Date()): Promise<boolean> {
    const batch = database.get(id);
    const members = database.shortParts(undefined, id);
    if (!batch || !members.length || !database.cancelUnsentShortBatch(id, reason, now)) return false;
    const parent = path.resolve(config.stagingRoot, "joined-sources");
    if (path.dirname(path.resolve(batch.sourcePath)) !== parent) throw new Error("Unsafe cancelled joined source path");
    await fs.rm(batch.sourcePath, { recursive: true, force: true });
    for (const memberId of new Set(members.map(p => p.recordingId))) {
        const member = database.get(memberId)!;
        const inspection = await inspectFinalizedRecording(member.sourcePath, member.provider, member.sourceKind);
        if (inspection.status === "finalized") {
            if (inspection.recording.sourceFingerprint !== member.sourceFingerprint
                && readRecordingFinalization(config.finalizationDatabasePath, member.sourcePath,
                    await fs.readFile(member.playlistPath, "utf8"))) database.refreshWaitingShort(inspection.recording, now);
        } else if (!await fs.access(member.sourcePath).then(() => true, () => false)) {
            database.discardMissingShort(memberId, "user removed a joined source before its upload", now);
        }
    }
    return true;
}
