import { open, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { moveToDesktopTrash } from "shared";

import { config } from "../../common/config.js";
import logger from "../../common/logger.js";
import { DownloadsManager } from "../state/downloadsManager.js";
import { finalizeInactiveRecording, promoteActiveRecording } from "../download/activeRecording.js";
import { parseCompoundSegmentName } from "../download/segmentIdentity.js";
import type { ProviderSnapshot } from "./providerSnapshot.js";

const TERMINAL_CONFIRMATION_MS = 60_000;
const PLAYLIST_TAIL_BYTES = 16_384;

interface ActiveRecording {
    kind: "resumable";
    path: string;
    alias: string;
    recordingId: string;
    playlistMtimeMs: number;
    hasEndlist: boolean;
}

interface NonResumableRecording {
    kind: "empty" | "legacy" | "blocked";
    path: string;
}

interface TerminalConfirmation {
    firstObservedAt: number;
    observationCount: number;
    playlistMtimeMs: number;
}

export interface ReconcileResult {
    resumePaths: Map<string, string>;
}

function aliasFromFolderName(folderName: string): string | null {
    const match = folderName.match(/^\d{4}-\d{2}-\d{2} \d{6} (.+)$/);
    return match?.[1] ?? null;
}

async function readTail(filePath: string): Promise<string | null> {
    let handle;
    try {
        handle = await open(filePath, "r");
        const stats = await handle.stat();
        const length = Math.min(stats.size, PLAYLIST_TAIL_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, stats.size - length);
        return buffer.toString("utf8");
    } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
    } finally {
        await handle?.close();
    }
}

async function inspectActiveRecording(recordingPath: string): Promise<ActiveRecording | NonResumableRecording | null> {
    const alias = aliasFromFolderName(path.basename(recordingPath));
    if (!alias) return null;
    const playlistPath = path.join(recordingPath, "playlist.m3u8");
    const tail = await readTail(playlistPath);
    const names = (tail ?? "").split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"));
    let identity = [...names].reverse()
        .map((name) => parseCompoundSegmentName(name))
        .find((candidate) => candidate !== null) ?? null;
    let activityMtimeMs: number;

    if (!identity) {
        const entries = await readdir(recordingPath, { withFileTypes: true });
        const diskIdentities = entries
            .filter((entry) => entry.isFile())
            .map((entry) => parseCompoundSegmentName(entry.name))
            .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
        const recordingIds = new Set(diskIdentities.map((candidate) => candidate.recordingId));
        if (recordingIds.size > 1) return { kind: "blocked", path: recordingPath };
        identity = diskIdentities.at(-1) ?? null;
        if (!identity) return { kind: tail === null || names.length === 0 ? "empty" : "legacy", path: recordingPath };
        activityMtimeMs = (await stat(recordingPath)).mtimeMs;
    } else {
        activityMtimeMs = (await stat(playlistPath)).mtimeMs;
    }

    if (!identity) {
        return { kind: names.length === 0 ? "empty" : "legacy", path: recordingPath };
    }
    return {
        kind: "resumable",
        path: recordingPath,
        alias,
        recordingId: identity.recordingId,
        playlistMtimeMs: activityMtimeMs,
        hasEndlist: (tail ?? "").split(/\r?\n/).some((line) => line.trim() === "#EXT-X-ENDLIST"),
    };
}

export class ActiveRecordingReconciler {
    private readonly activeRoot: string;
    private readonly confirmations = new Map<string, TerminalConfirmation>();

    constructor(
        private readonly providerName: string,
        private readonly downloadsManager: DownloadsManager,
        private readonly targetIdForAlias: (alias: string) => string | null,
        activeRoot?: string,
    ) {
        this.activeRoot = activeRoot ?? path.join(config.storagePath, providerName, "downloader", ".active");
    }

    public async recoverLocalState(): Promise<void> {
        let entries;
        try {
            entries = await readdir(this.activeRoot, { withFileTypes: true });
        } catch (error: any) {
            if (error?.code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const recording = await inspectActiveRecording(path.join(this.activeRoot, entry.name));
            if (!recording) continue;
            if (recording.kind === "blocked") {
                logger.warn(`[${this.providerName}] Leaving ambiguous active folder untouched: ${entry.name}`);
            } else if (recording.kind === "empty") {
                logger.info(`[${this.providerName}] Moving abandoned active folder without media to desktop Trash: ${entry.name}`);
                await moveToDesktopTrash(recording.path);
            } else if (recording.kind === "legacy") {
                logger.info(`[${this.providerName}] Finalizing legacy active recording without guessing an identity: ${entry.name}`);
                await finalizeInactiveRecording(recording.path);
            } else if (recording.kind === "resumable" && recording.hasEndlist) {
                const finalizedPath = await promoteActiveRecording(recording.path);
                logger.info(`[${this.providerName}] Completed interrupted active-to-finalized promotion: ${path.basename(finalizedPath)}`);
            }
        }
    }

    public async reconcile(snapshot: ProviderSnapshot): Promise<ReconcileResult> {
        const resumePaths = new Map<string, string>();
        let entries;
        try {
            entries = await readdir(this.activeRoot, { withFileTypes: true });
        } catch (error: any) {
            if (error?.code === "ENOENT") return { resumePaths };
            throw error;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const recording = await inspectActiveRecording(path.join(this.activeRoot, entry.name));
            if (!recording) continue;
            if (recording.kind !== "resumable") {
                if (this.downloadsManager.getActiveSegmentPaths().has(recording.path)) continue;
                if (recording.kind === "blocked") {
                    logger.warn(`[${this.providerName}] Leaving ambiguous active folder untouched: ${entry.name}`);
                } else if (recording.kind === "empty") {
                    logger.info(`[${this.providerName}] Moving abandoned active folder without media to desktop Trash: ${entry.name}`);
                    await moveToDesktopTrash(recording.path);
                } else {
                    logger.info(`[${this.providerName}] Finalizing legacy active recording without guessing an identity: ${entry.name}`);
                    await finalizeInactiveRecording(recording.path);
                }
                continue;
            }

            if (recording.hasEndlist) {
                const finalizedPath = await promoteActiveRecording(recording.path);
                this.confirmations.delete(recording.path);
                logger.info(`[${this.providerName}] Recovered completed active recording: ${path.basename(finalizedPath)}`);
                continue;
            }

            const aliasTargetId = this.targetIdForAlias(recording.alias);
            const identityMatch = aliasTargetId
                ? undefined
                : [...snapshot.live.values()]
                    .find((stream) => stream.recordingId === recording.recordingId);
            const targetId = aliasTargetId ?? identityMatch?.targetId ?? null;

            const current = targetId ? snapshot.live.get(targetId) : undefined;
            if (targetId && current?.recordingId === recording.recordingId) {
                this.confirmations.delete(recording.path);
                if (!this.downloadsManager.hasStreamer(targetId)) resumePaths.set(targetId, recording.path);
                continue;
            }

            if (current && current.recordingId !== recording.recordingId) {
                await this.finalize(targetId, recording.path, "recording identity changed");
                continue;
            }

            if (targetId && !snapshot.terminalTargetIds.has(targetId)) continue;

            const prior = this.confirmations.get(recording.path);
            const confirmation = !prior || recording.playlistMtimeMs > prior.playlistMtimeMs
                ? {
                    firstObservedAt: snapshot.observedAt,
                    observationCount: 1,
                    playlistMtimeMs: recording.playlistMtimeMs,
                }
                : {
                    ...prior,
                    observationCount: prior.observationCount + 1,
                };
            this.confirmations.set(recording.path, confirmation);

            if (
                confirmation.observationCount >= 2
                && snapshot.observedAt - confirmation.firstObservedAt >= TERMINAL_CONFIRMATION_MS
            ) {
                await this.finalize(targetId, recording.path, "terminal provider state confirmed for 60s without media progress");
            }
        }

        return { resumePaths };
    }

    private async finalize(targetId: string | null, recordingPath: string, reason: string): Promise<void> {
        logger.info(`[${this.providerName}] Finalizing ${path.basename(recordingPath)}: ${reason}`);
        const finalizedActiveSession = targetId
            ? await this.downloadsManager.finalizeStreamer(targetId)
            : false;
        if (!finalizedActiveSession) await finalizeInactiveRecording(recordingPath);
        this.confirmations.delete(recordingPath);
    }
}
