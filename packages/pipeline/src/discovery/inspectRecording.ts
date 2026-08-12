import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RecordingInput, SourceKind } from "../domain/types.js";

interface IntegrityReport {
    version?: unknown;
    status?: unknown;
    segmentCount?: unknown;
    invalidSegments?: unknown;
}

export interface DiscoveryRoot {
    readonly provider: string;
    readonly sourceKind: SourceKind;
    readonly path: string;
}

export type InspectionResult =
    | { readonly status: "eligible"; readonly recording: RecordingInput }
    | { readonly status: "excluded"; readonly sourcePath: string; readonly reason: string };

export type FinalizedInspectionResult =
    | { readonly status: "finalized"; readonly recording: RecordingInput }
    | { readonly status: "excluded"; readonly sourcePath: string; readonly reason: string };

function playlistDuration(content: string): number {
    return content.split(/\r?\n/).reduce((total, rawLine) => {
        const line = rawLine.trim();
        if (!line.startsWith("#EXTINF:")) return total;
        const value = Number.parseFloat(line.slice("#EXTINF:".length).split(",", 1)[0]);
        return Number.isFinite(value) && value > 0 ? total + value : total;
    }, 0);
}

function segmentNames(content: string): string[] {
    return content.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"));
}

function referencedMediaNames(content: string): string[] {
    const names = segmentNames(content);
    for (const rawLine of content.split(/\r?\n/)) {
        const match = rawLine.trim().match(/^#EXT-X-MAP:.*\bURI="([^"]+)"/);
        if (match && !names.includes(match[1])) names.push(match[1]);
    }
    return names;
}

async function fingerprint(sourcePath: string, playlistContent: string, segments: readonly string[]): Promise<string> {
    const hash = createHash("sha256").update(playlistContent);
    for (const name of segments) {
        if (path.basename(name) !== name) throw new Error(`Unsafe playlist entry: ${name}`);
        const stats = await fs.stat(path.join(sourcePath, name));
        hash.update(`\0${name}\0${stats.size}\0${Math.trunc(stats.mtimeMs)}`);
    }
    return hash.digest("hex");
}

export async function inspectFinalizedRecording(
    sourcePath: string,
    provider: string,
    sourceKind: SourceKind,
): Promise<FinalizedInspectionResult> {
    const resolvedSource = path.resolve(sourcePath);
    const playlistPath = path.join(resolvedSource, "playlist.m3u8");
    let content: string;
    try {
        content = await fs.readFile(playlistPath, "utf8");
    } catch {
        return { status: "excluded", sourcePath: resolvedSource, reason: "missing_playlist" };
    }
    if (!content.split(/\r?\n/).some((line) => line.trim() === "#EXT-X-ENDLIST")) {
        return { status: "excluded", sourcePath: resolvedSource, reason: "live_or_unfinalized" };
    }
    const durationSeconds = playlistDuration(content);
    if (durationSeconds <= 0) {
        return { status: "excluded", sourcePath: resolvedSource, reason: "invalid_duration" };
    }
    const mediaNames = referencedMediaNames(content);
    try {
        return {
            status: "finalized",
            recording: {
                provider,
                sourceKind,
                sourcePath: resolvedSource,
                playlistPath,
                sourceFingerprint: await fingerprint(resolvedSource, content, mediaNames),
                durationSeconds,
            },
        };
    } catch {
        return { status: "excluded", sourcePath: resolvedSource, reason: "segment_missing_or_unsafe" };
    }
}

export async function inspectRecording(
    sourcePath: string,
    provider: string,
    sourceKind: SourceKind,
): Promise<InspectionResult> {
    const finalized = await inspectFinalizedRecording(sourcePath, provider, sourceKind);
    if (finalized.status === "excluded") return finalized;
    const resolvedSource = finalized.recording.sourcePath;
    let report: IntegrityReport;
    try {
        report = JSON.parse(await fs.readFile(path.join(resolvedSource, ".media-integrity.json"), "utf8")) as IntegrityReport;
    } catch {
        return { status: "excluded", sourcePath: resolvedSource, reason: "integrity_missing" };
    }
    if (report.version !== 2) {
        return { status: "excluded", sourcePath: resolvedSource, reason: "integrity_version_unsupported" };
    }
    if (report.status !== "ready") {
        return { status: "excluded", sourcePath: resolvedSource, reason: `integrity_${String(report.status ?? "invalid")}` };
    }
    const playlistContent = await fs.readFile(finalized.recording.playlistPath, "utf8");
    const segments = segmentNames(playlistContent);
    if (report.segmentCount !== segments.length || !Array.isArray(report.invalidSegments) || report.invalidSegments.length !== 0) {
        return { status: "excluded", sourcePath: resolvedSource, reason: "integrity_evidence_mismatch" };
    }
    return { status: "eligible", recording: finalized.recording };
}

export async function scanRoots(roots: readonly DiscoveryRoot[]): Promise<InspectionResult[]> {
    const results: InspectionResult[] = [];
    for (const root of roots) {
        let entries;
        try {
            entries = await fs.readdir(path.resolve(root.path), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
            results.push(await inspectRecording(path.join(root.path, entry.name), root.provider, root.sourceKind));
        }
    }
    return results;
}

export async function scanFinalizedRoots(
    roots: readonly DiscoveryRoot[],
): Promise<FinalizedInspectionResult[]> {
    const byLogicalRecording = new Map<string, FinalizedInspectionResult>();
    for (const root of roots) {
        let entries;
        try {
            entries = await fs.readdir(path.resolve(root.path), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
            const sourcePath = path.resolve(root.path, entry.name);
            const key = `${root.provider}\0${entry.name}`;
            const result = await inspectFinalizedRecording(sourcePath, root.provider, root.sourceKind);
            const existing = byLogicalRecording.get(key);
            if (!existing || (root.sourceKind === "edited" && result.status === "finalized")) {
                byLogicalRecording.set(key, result);
            }
        }
    }
    return [...byLogicalRecording.values()];
}
