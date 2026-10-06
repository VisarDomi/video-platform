import * as timersPromises from "timers/promises";
import * as path from "path";

import logger from "../../common/logger.js";
import { DownloadHandle } from "../state/downloadsManager.js";
import { FileSystemManager } from "../../common/fileSystemManager.js";
import type { PlaylistManager, SegmentInfo } from "./playlistManager.js";
import { InitWriteError, type InitTracker } from "./initTracker.js";
import type { DiskSession } from "./diskSession.js";
import { IDownloadSession, IStreamProvider, PlaylistFetchFailure, SegmentFetchResult, SegmentValidationResult } from "../core/interfaces.js";
import { resolveSegmentUrl } from "../core/downloadUtils.js";
import { STALE_STREAM_TIMEOUT_MS, QUALITY_CHECK_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, NO_NEW_SEGMENTS_SLEEP_MS, INIT_RETRY_SLEEP_MS, EDGE_RECOVERY_SLEEP_MS, CDN_FETCH_TIMEOUT_MS, SEGMENT_RETRY_SLEEP_MS, POLL_WHILE_WAITING_MS } from "../../common/timing.js";
import { AccessIncidentTracker } from "./accessIncidentTracker.js";
import { PlaylistNotFoundError } from "../core/playlistNotFoundError.js";

export type ExitReason = import("../core/interfaces.js").DownloadExitContext["exitReason"];

// An empty/unreadable segment is refetched on later polls while the window
// lists it. A live window bounds this by itself; the attempt bound only keeps a
// window that stops moving (ENDLIST, stalled edge) from blocking later media.
export const REJECTED_SEGMENT_MAX_ATTEMPTS = 5;

export interface DownloadResult {
    segmentCount: number;
    aborted: boolean;
    exitReason: ExitReason;
    lastLiveUrl: string | null;
}

export class StreamDownloader {
    private handle: DownloadHandle;
    private provider: IStreamProvider;
    private accessIncidents: AccessIncidentTracker;
    private _aborted = false;
    private rejectedCount = 0;

    constructor(handle: DownloadHandle, provider: IStreamProvider, accessIncidents: AccessIncidentTracker) {
        this.handle = handle;
        this.provider = provider;
        this.accessIncidents = accessIncidents;
    }

    public abort(): void {
        this._aborted = true;
    }

    // Fetches segments four at a time; the consumer reads the results in order.
    // add() queues segments listed by a poll made while the consumer waited.
    private prefetchSegments(
        alias: string,
        segments: SegmentInfo[],
        session: IDownloadSession,
        isStale: () => boolean,
    ) {
        let stopped = false;
        let next = 0;
        let active = 0;
        const cancelled: SegmentFetchResult = { data: null, retryable: true };
        const jobs: { segment: SegmentInfo; result: Promise<SegmentFetchResult>; resolve: (result: SegmentFetchResult) => void }[] = [];
        const workers: Promise<void>[] = [];
        const shouldStop = () => stopped || this._aborted || isStale();
        const worker = async () => {
            while (next < jobs.length) {
                const job = jobs[next++];
                let result = cancelled;
                try {
                    while (!shouldStop()) {
                        result = await session.fetchSegment(job.segment.remoteUrl);
                        if (result.data || !result.retryable) break;
                        logger.debug(`[StreamDownloader] ${alias} segment fetch failed — retrying`, {
                            segment: job.segment.localName,
                            error: result.error ?? "retryable-fetch-failure",
                        });
                        if (shouldStop()) break;
                        await timersPromises.setTimeout(SEGMENT_RETRY_SLEEP_MS);
                    }
                } catch (error) {
                    result = { data: null, retryable: false, error: String(error) };
                }
                job.resolve(result);
            }
        };
        // A worker takes its first job synchronously; idle workers have exited.
        const add = (more: readonly SegmentInfo[]) => {
            if (stopped) return;
            for (const segment of more) {
                let resolve!: (result: SegmentFetchResult) => void;
                const result = new Promise<SegmentFetchResult>(done => { resolve = done; });
                jobs.push({ segment, result, resolve });
            }
            // Retries occupy one worker, not the entire download loop's segment batch.
            while (active < 4 && next < jobs.length) {
                active++;
                workers.push(worker().finally(() => { active--; }));
            }
        };
        add(segments);
        return {
            result: (index: number) => jobs[index].result,
            add,
            async close() { stopped = true; await Promise.all(workers); },
        };
    }

    // Waits for a segment's result, polling the live playlist every second
    // meanwhile: a slow download must not keep the loop from listing segments
    // that would leave the live window before the next regular poll. The poll
    // runs only while waiting, never beside an append.
    private async awaitPolling(
        result: Promise<SegmentFetchResult>,
        poll: () => Promise<void>,
    ): Promise<SegmentFetchResult> {
        while (true) {
            const timer = new AbortController();
            const settled = await Promise.race([
                result.then(() => true),
                timersPromises.setTimeout(POLL_WHILE_WAITING_MS, false, { signal: timer.signal }).catch(() => false),
            ]);
            timer.abort();
            if (settled || this._aborted) return await result;
            await poll();
        }
    }

    public async run(
        masterUrl: string,
        playlistManager: PlaylistManager,
        initTracker: InitTracker,
        disk: DiskSession,
    ): Promise<DownloadResult> {
        try {
            return await this.runAttempt(masterUrl, playlistManager, initTracker, disk);
        } catch (error) {
            if (!(error instanceof PlaylistNotFoundError)) throw error;
            logger.debug(`[StreamDownloader] ${this.handle.state?.alias}: live playlist returned 404; ending recording`, { url: error.url });
            return {
                segmentCount: initTracker.count,
                aborted: this._aborted,
                exitReason: this._aborted ? "aborted" : "playlist-not-found",
                lastLiveUrl: this.handle.state?.liveUrl ?? null,
            };
        }
    }

    private async runAttempt(
        masterUrl: string,
        playlistManager: PlaylistManager,
        initTracker: InitTracker,
        disk: DiskSession,
    ): Promise<DownloadResult> {
        const alias = this.handle.state?.alias ?? "unknown";
        const retainedLiveUrl = this.provider.refreshMasterDuringDownload === false
            ? this.handle.state?.liveUrl
            : null;
        const liveUrl = retainedLiveUrl ?? await this.provider.parseMasterPlaylist(masterUrl);

        if (!liveUrl) {
            logger.debug(`[StreamDownloader] EARLY-EXIT ${alias} reason=parseMasterPlaylist-failed`);
            return { segmentCount: 0, aborted: false, exitReason: "fetch-failed", lastLiveUrl: null };
        }

        this.handle.update({ liveUrl });

        const edgeMatch = liveUrl.match(/\/(b-hls-\d+)\//);
        const edge = edgeMatch ? edgeMatch[1] : "unknown";
        logger.debug(`[StreamDownloader] START ${alias} edge=${edge}`, {
            variant: this.provider.describeVariant?.(liveUrl) ?? null,
            variantPath: new URL(liveUrl).pathname,
        });

        let session = this.provider.createDownloadSession();
        playlistManager.setEdge(liveUrl);

        return await this.downloadLoop(alias, masterUrl, liveUrl, session, playlistManager, initTracker, disk);
    }

    private async recordAccessFailure(
        stage: "playlist" | "segment",
        alias: string,
        masterUrl: string,
        liveUrl: string,
        failure: PlaylistFetchFailure,
    ): Promise<void> {
        const state = this.handle.state;
        if (!state) return;
        const recorded = this.accessIncidents.record(failure);
        if (!recorded.opened) return;

        const identity = {
            provider: this.provider.providerName,
            streamerId: state.streamerId,
            alias,
            recordingId: state.recordingId,
        };
        // One warning per incident, carrying the provider's diagnosis when it has one.
        let evidence: object = {};
        if (this.provider.diagnoseAccessFailure) {
            try {
                evidence = await this.provider.diagnoseAccessFailure({
                    stage,
                    ...identity,
                    masterUrl,
                    liveUrl,
                    failure,
                });
            } catch (error: any) {
                evidence = { evidenceUnavailable: error.name ?? "diagnostic-error" };
            }
        }
        logger.warn(`[${this.provider.providerName.toUpperCase()}] ACCESS_INCIDENT_OPEN`, {
            ...identity,
            stage,
            failure,
            selected: this.provider.describeVariant?.(liveUrl) ?? null,
            ...evidence,
        });
    }

    private closeAccessIncident(alias: string, liveUrl: string, outcome: string): void {
        const state = this.handle.state;
        const closed = this.accessIncidents.close(outcome);
        if (!state || !closed) return;
        logger.info(`[${this.provider.providerName.toUpperCase()}] ACCESS_INCIDENT_CLOSE`, {
            provider: this.provider.providerName,
            streamerId: state.streamerId,
            alias,
            recordingId: state.recordingId,
            outcome,
            durationMs: closed.durationMs,
            attempts: closed.attempts,
            failures: closed.failures,
            selected: this.provider.describeVariant?.(liveUrl) ?? null,
        });
    }

    private async checkForQualityUpgrade(
        alias: string,
        masterUrl: string,
        currentLiveUrl: string,
    ): Promise<string | null> {
        const betterUrl = await this.provider.parseMasterPlaylist(masterUrl);
        if (!betterUrl) {
            logger.debug(`[StreamDownloader] ${alias} quality check: master playlist unavailable`);
            return null;
        }

        const normalize = (url: string) =>
            url.split("?")[0].replace(/doppiocdn\.(org|com|net)/g, "doppiocdn._");

        if (normalize(betterUrl) === normalize(currentLiveUrl)) {
            logger.debug(`[StreamDownloader] ${alias} quality check: no change`);
            return null;
        }
        return betterUrl;
    }

    private async downloadLoop(
        alias: string,
        masterUrl: string,
        initialLiveUrl: string,
        initialSession: IDownloadSession,
        playlistManager: PlaylistManager,
        initTracker: InitTracker,
        disk: DiskSession,
    ): Promise<DownloadResult> {
        let liveUrl = initialLiveUrl;
        let session = initialSession;
        let lastDownload = Date.now();
        let segmentFailed = false;
        let remoteEndlist = false;
        let health: 'ok' | 'stale' = 'ok';
        let lastQualityCheck = Date.now();
        let masterCheckMs: number | null = null;
        const staleTimeout = STALE_STREAM_TIMEOUT_MS;

        downloadLoop: while (!this._aborted && Date.now() - lastDownload < staleTimeout) {
            if (health === 'ok' && Date.now() - lastDownload > HEARTBEAT_INTERVAL_MS) {
                health = 'stale';
                const staleSec = ((Date.now() - lastDownload) / 1000).toFixed(0);
                logger.debug(`[StreamDownloader] STALE ${alias} segments=${initTracker.count} staleSec=${staleSec}`);
            }

            if (this.provider.refreshMasterDuringDownload !== false
                && Date.now() - lastQualityCheck > QUALITY_CHECK_INTERVAL_MS) {
                lastQualityCheck = Date.now();
                const betterUrl = await this.checkForQualityUpgrade(alias, masterUrl, liveUrl);
                masterCheckMs = Date.now() - lastQualityCheck;
                if (betterUrl) {
                    logger.info(`[StreamDownloader] VARIANT_CHANGE ${alias}`, {
                        reason: "master-selection-changed",
                        from: this.provider.describeVariant?.(liveUrl) ?? null,
                        to: this.provider.describeVariant?.(betterUrl) ?? null,
                        fromPath: new URL(liveUrl).pathname,
                        toPath: new URL(betterUrl).pathname,
                    });
                    liveUrl = betterUrl;
                    this.handle.update({ liveUrl });
                }
            }

            const playlistFetchStartedAt = Date.now();
            let content = await session.fetchPlaylist(liveUrl);
            const playlistFetchMs = Date.now() - playlistFetchStartedAt;
            if (!content) {
                const failure = session.getLastPlaylistFailure?.();
                if (failure) await this.recordAccessFailure("playlist", alias, masterUrl, liveUrl, failure);
                const recovered = await this.provider.recoverVariant(this.handle.masterPlaylistUrl);
                if (!recovered) {
                    logger.debug(`[StreamDownloader] ${alias} variant failed, no recovery candidate (segments=${initTracker.count})`);
                    await timersPromises.setTimeout(this.provider.playlistRetryMs ?? EDGE_RECOVERY_SLEEP_MS);
                    continue;
                }

                const oldEdge = playlistManager.timeline.edge;
                const newEdgeMatch = recovered.match(/\/(b-hls-\d+)\//);
                const newEdge = newEdgeMatch ? newEdgeMatch[1] : null;

                if (newEdge && newEdge !== oldEdge) {
                    playlistManager.setEdge(recovered);
                    playlistManager.onEdgeSwitch(oldEdge, newEdge);
                    logger.debug(`[StreamDownloader] ${alias} EDGE-SWITCH ${oldEdge ?? "none"} → ${newEdge}`, {
                        variant: this.provider.describeVariant?.(recovered) ?? null,
                        variantPath: new URL(recovered).pathname,
                    });
                } else {
                    logger.debug(`[StreamDownloader] ${alias} recovery candidate uses same edge`);
                }

                liveUrl = recovered;
                this.handle.update({ liveUrl });
                session = this.provider.createDownloadSession();

                content = await session.fetchPlaylist(liveUrl);
                if (!content) {
                    const recoveredFailure = session.getLastPlaylistFailure?.();
                    if (recoveredFailure) await this.recordAccessFailure("playlist", alias, masterUrl, liveUrl, recoveredFailure);
                    logger.debug(`[StreamDownloader] ${alias} recovery candidate also failed`);
                    await timersPromises.setTimeout(this.provider.playlistRetryMs ?? EDGE_RECOVERY_SLEEP_MS);
                    continue;
                }
            }
            this.closeAccessIncident(alias, liveUrl, "playlist-recovered");

            const mapMatch = content.match(/#EXT-X-MAP:URI="([^"]+)"/);
            if (mapMatch) {
                const mapUri = mapMatch[1];
                if (initTracker.needsUpdate(mapUri)) {
                    const initUrl = resolveSegmentUrl(liveUrl, mapUri);
                    let result;
                    try {
                        result = await initTracker.commitInit(
                            mapUri,
                            () => session.fetchSegment(initUrl),
                            playlistManager.nextSegmentNumber,
                        );
                    } catch (error) {
                        // Already logged by the write; the session decides what follows.
                        if (!(error instanceof InitWriteError)) throw error;
                        segmentFailed = true;
                        break;
                    }

                    if (!result) {
                        logger.debug(`[StreamDownloader] ${alias} init segment failed — retrying`);
                        await timersPromises.setTimeout(INIT_RETRY_SLEEP_MS);
                        continue;
                    }

                    if (result.isQualityChange) {
                        playlistManager.bufferQualityChange(result.fileName);
                    }

                    logger.debug(`[StreamDownloader] Downloaded init segment for ${alias} (${result.fileName})`);
                }
            }

            // A late poll's gap reports what this poll and a master check since the
            // previous poll took: the requests that can hold the loop up.
            const identifiedSegments = await playlistManager.identifyNewSegments(
                content,
                (line) => resolveSegmentUrl(liveUrl, line),
                undefined,
                `playlistFetch=${playlistFetchMs}ms${masterCheckMs === null ? "" : ` masterCheck=${masterCheckMs}ms`}`,
            );
            masterCheckMs = null;
            const segments = identifiedSegments.filter(segment => !playlistManager.shouldSkipByTimeline(segment));

            let downloadedThisIteration = false;
            let rejectedRetryPending = false;

            const prefetch = this.prefetchSegments(alias, segments, session,
                () => Date.now() - lastDownload >= staleTimeout);
            // Segments listed while waiting join this batch after the queued ones.
            // A playlist change that needs the main loop (an unavailable or ended
            // playlist, a new init map, a numbering restart) is left to the next
            // regular poll, after this batch is saved.
            const pollWhileWaiting = async () => {
                const queuedThrough = segments.at(-1)?.providerSequence;
                if (queuedThrough === undefined || Date.now() - lastDownload >= staleTimeout) return;
                const latest = await session.fetchPlaylist(liveUrl).catch(() => null);
                if (!latest) return;
                const latestMap = latest.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
                if (latestMap && initTracker.needsUpdate(latestMap)) return;
                const more = (await playlistManager.identifyNewSegments(
                    latest,
                    (line) => resolveSegmentUrl(liveUrl, line),
                    queuedThrough,
                )).filter(segment => !playlistManager.shouldSkipByTimeline(segment));
                if (more.length === 0) return;
                segments.push(...more);
                prefetch.add(more);
            };
            try {
                for (let index = 0; index < segments.length; index++) {
                    const segment = segments[index];
                    const fetchResult = await this.awaitPolling(prefetch.result(index), pollWhileWaiting);
                    if (this._aborted || (!fetchResult.data && fetchResult.retryable)) break downloadLoop;

                    if (!fetchResult.data) {
                        if (fetchResult.status !== undefined) {
                            await this.recordAccessFailure("segment", alias, masterUrl, liveUrl, {
                                kind: "http",
                                status: fetchResult.status,
                            });
                        }
                        logger.warn(`[StreamDownloader] ${alias} segment download failed — stopping`, {
                            segment: segment.localName,
                            providerSequence: segment.providerSequence,
                            status: fetchResult.status ?? null,
                            error: fetchResult.error ?? null,
                        });
                        segmentFailed = true;
                        break;
                    }
                    const tsBuffer = fetchResult.data;

                    // An empty body carries no media: nothing is written.
                    let rejection: string | null = tsBuffer.length === 0 ? "empty-download" : null;
                    let result: SegmentValidationResult = { valid: false };
                    if (rejection === null) {
                        if (!await disk.materialize()) {
                            logger.error(`[StreamDownloader] ${alias} disk materialization failed — stopping`);
                            segmentFailed = true;
                            break;
                        }

                        const segmentPath = path.join(disk.dirPath, segment.localName);
                        const written = await FileSystemManager.writeFileExclusive(segmentPath, tsBuffer as unknown as Uint8Array);
                        if (written !== "written") {
                            logger.error(`[StreamDownloader] ${alias} disk write failed segment=${segmentPath} — stopping`);
                            segmentFailed = true;
                            break;
                        }

                        result = await this.provider.validateSegment(segmentPath);
                        // Received bytes are never deleted; an unreadable file
                        // stays on disk and finalization reports it.
                        if (!result.valid) rejection = "unreadable-after-write";
                    }

                    if (rejection !== null) {
                        // Not handled: the sequence stays below the baseline so
                        // the next poll fetches it again while the live window
                        // lists it. Later segments wait to keep playlist order.
                        this.rejectedCount++;
                        const attempts = playlistManager.noteRejectedSegment(segment.providerSequence);
                        const details = {
                            segment: segment.localName,
                            providerSequence: segment.providerSequence,
                            reason: rejection,
                            attempt: attempts,
                            maxAttempts: REJECTED_SEGMENT_MAX_ATTEMPTS,
                        };
                        if (attempts < REJECTED_SEGMENT_MAX_ATTEMPTS) {
                            logger.warn(`[StreamDownloader] ${alias} segment rejected — refetching on the next poll`, details);
                            rejectedRetryPending = true;
                            break;
                        }
                        logger.warn(`[StreamDownloader] ${alias} segment still rejected — continuing without it`, details);
                        playlistManager.abandonRejectedSegment(segment.providerSequence);
                    } else {
                        segment.dimensions = result.dimensions;
                        if (result.duration !== undefined) {
                            segment.accurateDuration = result.duration;
                        }
                        await playlistManager.appendSegmentToPlaylist(segment);
                        playlistManager.recordDownloadedPDT(segment.programDateTime);
                        if (health === 'stale') {
                            health = 'ok';
                            const staleSec = ((Date.now() - lastDownload) / 1000).toFixed(0);
                            logger.debug(`[StreamDownloader] RECOVERED ${alias} segments=${initTracker.count} staleSec=${staleSec}`);
                        }
                        lastDownload = Date.now();
                        initTracker.incrementSegmentCount();
                        downloadedThisIteration = true;
                    }
                }
            } finally {
                await prefetch.close();
            }

            if (segmentFailed) break;

            // A final playlist still gets its rejected segment refetched (up
            // to the attempt bound) and every later segment saved.
            if (!rejectedRetryPending && content.split(/\r?\n/).some((line) => line.trim() === "#EXT-X-ENDLIST")) {
                remoteEndlist = true;
                logger.debug(`[StreamDownloader] ${alias}: upstream playlist supplied ENDLIST`);
                break;
            }

            if (!downloadedThisIteration) {
                await timersPromises.setTimeout(NO_NEW_SEGMENTS_SLEEP_MS);
            }
        }

        const staleSec = ((Date.now() - lastDownload) / 1000).toFixed(0);
        const staleTimedOut = Date.now() - lastDownload >= staleTimeout;
        let exitReason: ExitReason;
        if (this._aborted) {
            exitReason = "aborted";
        } else if (remoteEndlist) {
            exitReason = "remote-endlist";
        } else if (segmentFailed) {
            exitReason = "segment-failed";
        } else if (staleTimedOut) {
            exitReason = "stale-timeout";
        } else {
            exitReason = "fetch-failed";
        }
        const timeline = playlistManager.timeline;
        const timelineDetails = timeline.edge
            ? ` edge=${timeline.edge} seq=${timeline.mediaSequence} firstPDT=${timeline.firstProgramDateTime ?? "none"} lastPDT=${timeline.lastProgramDateTime ?? "none"}`
            : "";
        const rejStr = this.rejectedCount > 0 ? ` rejected=${this.rejectedCount}` : "";
        logger.debug(`[StreamDownloader] LOOP-EXIT ${alias} reason=${exitReason} staleSec=${staleSec} segments=${initTracker.count}${rejStr}${disk.materialized ? ` dir=${path.basename(disk.dirPath)}` : ""}${timelineDetails}`);

        return { segmentCount: initTracker.count, aborted: this._aborted, exitReason, lastLiveUrl: liveUrl };
    }
}
