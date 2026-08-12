import logger from "../../common/logger.js";
import { IStreamProvider } from "../core/interfaces.js";
import { StreamSession, SessionResult } from "../download/streamSession.js";
import { DownloadsManager } from "../state/downloadsManager.js";
import { RetryCooldown } from "./retryCooldown.js";

export interface StreamStartCandidate {
    streamerId: string;
    alias: string;
    recordingId: string;
    masterPlaylistUrl: string;
    existingDirPath?: string;
}

export function startStreamSession(
    providerLabel: string,
    candidate: StreamStartCandidate,
    provider: IStreamProvider,
    downloadsManager: DownloadsManager,
    cooldown: RetryCooldown,
): boolean {
    const handle = downloadsManager.add(candidate.masterPlaylistUrl, {
        streamerId: candidate.streamerId,
        alias: candidate.alias,
        recordingId: candidate.recordingId,
    });

    if (!handle) {
        return false;
    }

    logger.info(`[${providerLabel}] Initiating session for ${candidate.alias}...`);
    const session = new StreamSession(
        candidate.streamerId,
        candidate.alias,
        handle,
        provider,
        candidate.recordingId,
        candidate.existingDirPath,
    );
    const completion = session.run(candidate.masterPlaylistUrl).then((result: SessionResult) => {
        if (result.aborted) {
            logger.info(`[${providerLabel}] ${candidate.alias}: session paused for shutdown (${result.totalSegments} new segments)`);
        } else if (result.totalSegments === 0) {
            logger.warn(`[${providerLabel}] ${candidate.alias}: session ended with 0 segments — cooldown`);
            cooldown.recordFailure(candidate.streamerId);
        } else if (result.totalSegments > 0) {
            logger.info(`[${providerLabel}] ${candidate.alias}: session completed (${result.totalSegments} segments)`);
            cooldown.clear(candidate.streamerId);
        }
    }).catch((err: Error) => {
        logger.error(`[${providerLabel}] ${candidate.alias}: unhandled session error`, { error: err.message });
        handle.remove();
        cooldown.recordFailure(candidate.streamerId);
    });

    downloadsManager.registerDownloader(
        candidate.masterPlaylistUrl,
        candidate.streamerId,
        () => session.abort(),
        () => session.finalize(),
        completion,
    );
    return true;
}
