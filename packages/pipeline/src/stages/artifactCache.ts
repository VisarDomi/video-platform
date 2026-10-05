import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { syncFile, syncPublishedArtifact } from "./durableArtifact.js";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactRecord, Recording } from "../domain/types.js";
import { containedArtifactPath } from "./remux.js";
import { productionArtifactSuffix } from "./artifactNaming.js";
import { RESOLUTION_POLICY_VERSION, resolutionPolicyReason } from "./resolutionPolicy.js";
import { artifactSha256 } from "./validateArtifact.js";

// Independent of the upload generation. Bump when encoder/filter/remux settings
// change output semantics, even if the resolution-selection policy stays put.
// v2 (2026-10-05): always converted, portrait turned counterclockwise, shapes split.
export const ARTIFACT_RECIPE_VERSION = "artifact-recipe-v2";

export interface ArtifactCacheConfig {
    readonly databasePath: string;
    readonly artifactsRoot: string;
}

interface Candidate extends Omit<ArtifactRecord, "recordingId"> {
    readonly generation: string;
    readonly reason: string;
}

export function artifactRecipeReason(reason: string): string {
    return resolutionPolicyReason(`[${ARTIFACT_RECIPE_VERSION}] ${reason}`);
}

async function historyDatabases(databasePath: string): Promise<string[]> {
    const root = path.join(path.dirname(databasePath), "history");
    const generations = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    const result = [databasePath];
    for (const generation of generations.filter((entry) => entry.isDirectory()
        && /^production-v\d+$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
        const directory = path.join(root, generation.name);
        for (const entry of (await fs.readdir(directory, { withFileTypes: true })).reverse()) {
            if (entry.isFile() && entry.name.endsWith(".sqlite")) result.push(path.join(directory, entry.name));
        }
    }
    return result;
}

// Rollover already takes complete immutable DB snapshots. They are the durable
// cache manifests: read ONLY media evidence, never old upload state/remote IDs.
// No catalog scan, segment ffprobe, database migration, or source rewrite.
export async function findArtifactCacheCandidates(
    recording: Recording,
    config: ArtifactCacheConfig,
): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const databasePath of await historyDatabases(config.databasePath)) {
        if (!(await fs.lstat(databasePath).catch(() => null))?.isFile()) continue;
        let database: DatabaseSync | undefined;
        try {
            database = new DatabaseSync(databasePath, { readOnly: true });
            const version = database.prepare("SELECT version FROM production_version WHERE id = 1").get() as { version: string };
            if (!/^production-v\d+$/.test(version.version)) continue;
            const row = database.prepare(`
                SELECT a.path, a.size_bytes AS sizeBytes, a.sha256, a.validated_at AS validatedAt,
                    (SELECT e.reason FROM state_events e WHERE e.recording_id = r.id
                     AND e.from_state = 'server_ready' AND e.to_state = 'remuxed'
                     ORDER BY e.id DESC LIMIT 1) AS reason
                FROM recordings r JOIN artifacts a ON a.recording_id = r.id
                JOIN remux_outputs o ON o.recording_id = r.id AND o.path = a.path
                WHERE r.id = ? AND r.provider = ? AND r.source_kind = ? AND r.source_path = ?
                    AND r.playlist_path = ? AND r.source_fingerprint = ? AND a.part = 'full'
                    AND NOT EXISTS (SELECT 1 FROM state_events e WHERE e.recording_id = r.id
                        AND e.reason IN ('source fingerprint changed', 'cross-provider folder name collision'))
            `).get(recording.id, recording.provider, recording.sourceKind, path.resolve(recording.sourcePath),
                path.resolve(recording.playlistPath), recording.sourceFingerprint) as Omit<Candidate, "generation"> | undefined;
            if (!row || typeof row.reason !== "string" || !row.reason.startsWith(`${RESOLUTION_POLICY_VERSION}:`)) continue;
            // Only the current recipe's tag authorizes reuse; never an older recipe.
            if (!row.reason.startsWith(artifactRecipeReason(""))) continue;
            const root = path.resolve(config.artifactsRoot, version.version);
            // Whole-recording artifacts of the current recipe only (split parts are never reused).
            const allowedPaths = [productionArtifactSuffix("full", false), productionArtifactSuffix("full", true)]
                .map((suffix) => containedArtifactPath(root, recording.id, suffix));
            if (!allowedPaths.includes(row.path) || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes <= 0
                || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isFinite(Date.parse(row.validatedAt))) continue;
            if (!candidates.some((candidate) => candidate.path === row.path && candidate.sha256 === row.sha256)) {
                candidates.push({ ...row, generation: version.version });
            }
        } catch (error) {
            // Older schemas/damaged historical manifests cannot authorize reuse.
            console.warn(`[artifact-cache] Cannot read media evidence from ${databasePath}: ${String(error)}`);
        } finally {
            database?.close();
        }
    }
    return candidates;
}

async function matches(artifactPath: string, candidate: Candidate): Promise<boolean> {
    const stats = await fs.lstat(artifactPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    return !!stats?.isFile() && stats.size === candidate.sizeBytes
        && await artifactSha256(artifactPath) === candidate.sha256;
}

export async function reuseCachedArtifact(
    recording: Recording,
    stagingRoot: string,
    config: ArtifactCacheConfig,
): Promise<{ path: string; eventReason: string } | null> {
    for (const candidate of await findArtifactCacheCandidates(recording, config)) {
        const sourceStats = await fs.lstat(candidate.path).catch(() => null);
        if (!sourceStats?.isFile() || sourceStats.size !== candidate.sizeBytes) continue;
        // Reject symlinked parents as well as symlinked artifact files.
        if (await fs.realpath(candidate.path) !== candidate.path) continue;
        const target = path.join(path.resolve(stagingRoot), path.basename(candidate.path));
        await fs.mkdir(stagingRoot, { recursive: true });
        const temporary = `${target}.${randomUUID()}.cache-partial`;
        try {
            // Hardlinks keep one physical copy on the same filesystem. Cleanup
            // unlinks only this generation's name; it cannot delete older links.
            // Cross-filesystem staging falls back to an exclusive byte copy.
            try {
                await fs.link(candidate.path, temporary);
            } catch (error) {
                if (!["EXDEV", "EPERM", "EOPNOTSUPP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
                await fs.copyFile(candidate.path, temporary, constants.COPYFILE_EXCL);
            }
            // Verify bytes BEFORE publishing. Missing/corrupt cache = a miss,
            // never an excuse to adopt an unproven same-name MP4.
            if (!await matches(temporary, candidate)) continue;
            await syncFile(temporary);
            try {
                await fs.link(temporary, target);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                if (!await matches(target, candidate)) throw new Error(`Cache target conflicts with an existing artifact: ${target}`);
            }
            await syncPublishedArtifact(target);
            return {
                path: target,
                eventReason: artifactRecipeReason(`artifact cache hit from ${candidate.generation}; sha256=${candidate.sha256}`),
            };
        } finally {
            await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
            });
        }
    }
    return null;
}
