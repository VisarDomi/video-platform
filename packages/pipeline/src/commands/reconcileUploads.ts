import { settleUnsubmitted } from "../upload/destinationFacts.js";
import type { PipelineConfig } from "../config.js";
import { PipelineDatabase, UPLOAD_CHECK_MILLISECONDS } from "../db/pipelineDatabase.js";
import { cleanupAcceptedConversions } from "./acceptedConversions.js";
import { inspectFinalizedRecording } from "../discovery/inspectRecording.js";
import { createProviderUploader } from "../upload/providerFactory.js";
import { writeComparisonReport } from "./comparisonTrial.js";
import { CURRENT_PRODUCTION_VERSION } from "../domain/productionVersion.js";
import { uploadLookupIdentity } from "../metadata/composeUploadMetadata.js";
import { swappedWords, type Destination, type DestinationSession, type UploadLookup, type UploadProbe } from "sdk";


async function retrySourceUnchanged(database: PipelineDatabase, id: string): Promise<boolean> {
    const recording=database.get(id);
    if(!recording || database.providerRemovals(id).length) return false;
    const inspection=await inspectFinalizedRecording(recording.sourcePath,recording.provider,recording.sourceKind);
    if(inspection.status!=='finalized' || inspection.recording.sourceFingerprint!==recording.sourceFingerprint) return false;
    for(const member of database.shortParts(undefined,id)) {
        const original=database.get(member.recordingId);
        if(!original || original.sourceFingerprint!==member.sourceFingerprint
            || database.shortParts(undefined,original.id).length
            || !await retrySourceUnchanged(database,original.id)) return false;
    }
    return true;
}

// A destination's page-level session, as tests hand one in: the uploader's own methods
// on one signed-in page. Production passes none and uses the destination's sessions.
export interface PageLevelBrowser {
    withAuthenticatedPage<T>(action: (page: any) => Promise<T>): Promise<T>;
    probeUploadStatus(page: any, remoteId: string): Promise<UploadProbe>;
    lookupUpload?(page: any, identity: string, exactRemoteId?: string): Promise<UploadLookup>;
}

type ReconcileSession = Pick<DestinationSession, "probe"> & Partial<Pick<DestinationSession, "lookup">>;

function pageLevelSessions(browser: PageLevelBrowser): { withSession<T>(action: (session: ReconcileSession) => Promise<T>): Promise<T> } {
    return {
        withSession: (action) => browser.withAuthenticatedPage((page) => action({
            probe: (remoteId) => browser.probeUploadStatus(page, remoteId),
            ...(browser.lookupUpload ? { lookup: (identity: string, exactRemoteId?: string) => browser.lookupUpload!(page, identity, exactRemoteId) } : {}),
        })),
    };
}

export async function reconcileDueUploads(config: PipelineConfig, now = new Date(),
    browserOverride?: PageLevelBrowser,
    providerFactory: (config: PipelineConfig, provider: never) => Promise<Pick<Destination, "withSession">> = createProviderUploader,
): Promise<unknown> {
    if (!config.networkUploadsEnabled) {
        throw new Error("Network reconciliation is disabled; explicit VIDEO_PIPELINE_NETWORK_UPLOADS=1 opt-in is required");
    }
    const database = new PipelineDatabase(config.databasePath);
    const results: unknown[] = [];
    try {
        if (config.comparisonTrialOnly && database.getProductionVersion() !== CURRENT_PRODUCTION_VERSION) {
            throw new Error("Retired-version verification must not run in the v4 comparison worker");
        }
        results.push(...database.recoverInterruptedUploads(now));
        database.recoverAcceptedVerifications(now);
        results.push(...await cleanupAcceptedConversions(database,config,now));
        results.push(...(await settleUnsubmitted(database, now))
            .map((recordingId) => ({ recordingId, disposition: "unsubmitted_attempt_released" })));
        // One login flow, then every due confirmation is checked on that same
        // authenticated page.
        const due = database.dueUploadConfirmations(now);
        if (due.length === 0) return { checkedAt: now.toISOString(), results };
        // Each confirmation is checked at the destination its attempt went to, not today's
        // active one: switching destinations never strands an earlier upload unconfirmed.
        for (const provider of new Set(due.map(confirmation => confirmation.uploadProvider))) {
        const providerDue = due.filter(confirmation => confirmation.uploadProvider === provider);
        try {
        const destination: { withSession<T>(action: (session: ReconcileSession) => Promise<T>): Promise<T> } = browserOverride
            ? pageLevelSessions(browserOverride) : await providerFactory(config, provider as never);
        await destination.withSession(async (session) => {
            for (const confirmation of providerDue) {
                try {
                let remoteId = database.getUncertainUploadRemote(confirmation.attemptId)?.remoteId ?? null;
                let probe = remoteId ? await session.probe(remoteId) : null;
                // A copy the destination proved removed (gone from its complete list) is
                // recorded at once and never uploaded there again. Only a copy that failed or
                // never became playable waits for the seven-day gate and is then uploaded again.
                const removed = async (id: string, reason: string | undefined, proven: boolean) => {
                    if(!proven && database.acceptedUpload(confirmation.attemptId)) {
                        const accepted=database.acceptedUpload(confirmation.attemptId)!;
                        if(now.toISOString()<accepted.retryAfter) {
                            database.postponeConfirmation(confirmation.attemptId,reason ?? 'Copy is not ready; check daily before the seven-day retry deadline',now,UPLOAD_CHECK_MILLISECONDS);
                            results.push({recordingId:confirmation.recordingId,disposition:'not_ready',remoteId:id,reason});
                            return;
                        }
                        const ready=await retrySourceUnchanged(database,confirmation.recordingId);
                        const queued=database.retryAcceptedConversion(confirmation.attemptId,ready,
                            ready ? 'not playable seven days after acceptance; convert and upload again'
                                : 'not playable after seven days; original source missing or changed, history retained',now);
                        if(queued || !ready) {
                            if(!queued) database.postponeConfirmation(confirmation.attemptId,'retry awaits unchanged original; continue remote verification',now);
                            results.push({recordingId:confirmation.recordingId,disposition:queued?'conversion_retry_queued':'retry_source_unavailable',remoteId:id});
                            return;
                        }
                    }
                    // The provider gave this video an ID, so it existed; now it is
                    // gone (404 and unlisted). Never back to that provider.
                    database.markProviderRemoved(confirmation.attemptId, id,
                        `${confirmation.uploadProvider} removed video ${id} after upload (${reason ?? "404"}); retained locally and excluded from re-upload`, now);
                    results.push({ recordingId: confirmation.recordingId, disposition: "provider_removed", remoteId: id });
                };
                if (remoteId && probe?.outcome === "missing") {
                    await removed(remoteId, probe.reason, probe.removed === true);
                    continue;
                }
                if (!remoteId) {
                    const recording = database.get(confirmation.recordingId);
                    const metadata = database.getUploadMetadata(confirmation.recordingId);
                    const identity = recording && metadata ? uploadLookupIdentity(recording,
                        database.getArtifactPart(recording.id) ?? "full", metadata.title) : null;
                    if (identity && session.lookup) {
                        const lookup = await session.lookup(identity);
                        if (lookup.kind === "found") {
                            remoteId = lookup.remoteId;
                            database.attachUncertainRemote(confirmation.attemptId, remoteId);
                            database.acknowledgeRecoveredAcceptance(confirmation.attemptId);
                            await cleanupAcceptedConversions(database,config,now);
                        }
                        const requeued = database.recordUploadLookup(confirmation.attemptId, lookup.kind, now);
                        database.recordUploadEvidence(confirmation.attemptId, { stage: "filename_lookup", identity, ...lookup }, now);
                        if (requeued) {
                            results.push({ recordingId: confirmation.recordingId, disposition: "weekly_retry_eligible" });
                            continue;
                        }
                    }
                }
                if (!remoteId) {
                    database.postponeConfirmation(confirmation.attemptId,
                        "No unique filename match; daily lookup, no upload before a clean negative lookup and weekly deadline", now);
                    results.push({
                        recordingId: confirmation.recordingId,
                        disposition: "identity_recheck_scheduled",
                        reason: "no stored edit ID; acceptance still unknown",
                    });
                    continue;
                }
                probe ??= await session.probe(remoteId);
                if (probe.outcome === "missing") {
                    await removed(remoteId, probe.reason, probe.removed === true);
                    continue;
                }
                const { stored, ...probeEvidence } = probe;
                database.recordUploadEvidence(confirmation.attemptId, { stage: "playback_verification", remoteId, ...probeEvidence }, now);
                const sent = stored ? database.getUploadMetadata(confirmation.recordingId) : null;
                if (stored && sent) {
                    // A destination may silently swap filtered words: learn them so new
                    // descriptions avoid them (the prompt appends every learned phrase).
                    const learned = [...new Set([...swappedWords(sent.title, stored.title), ...swappedWords(sent.description, stored.description)])];
                    if (learned.length) {
                        database.recordRejectedPhrases(confirmation.uploadProvider, learned, confirmation.attemptId, now);
                        database.recordUploadEvidence(confirmation.attemptId, { stage: "provider_swapped_words", learned }, now);
                        results.push({ recordingId: confirmation.recordingId, disposition: "learned_swapped_words", learned });
                    }
                }
                if (probe.outcome === "online" && probe.remoteUrl) {
                    const afterVerification = database.verifyUpload(confirmation.attemptId,remoteId,probe.remoteUrl,now);
                    await cleanupAcceptedConversions(database,config,now);
                    if(config.cleanupEnabled && afterVerification.state==='upload_verified' && !database.getComparisonTrial()) database.transition(
                        confirmation.recordingId,'upload_verified','cleanup_eligible','all required parts verified online',now);
                    results.push({
                        recordingId: confirmation.recordingId,
                        disposition: "online",
                        remoteId,
                        remoteUrl: probe.remoteUrl,
                    });
                } else {
                    // A confirmed processing/non-public copy still absent at its
                    // seven-day deadline is rebuilt; transport/probe failures are
                    // inconclusive and published low-resolution legacy copies stay held.
                    if(probe.processing === true && database.acceptedUpload(confirmation.attemptId)) {
                        await removed(remoteId,probe.reason,false);
                        continue;
                    }
                    database.postponeConfirmation(confirmation.attemptId,
                        probe.reason ?? "Full-HD playback not yet confirmed", now, UPLOAD_CHECK_MILLISECONDS);
                    results.push({
                        recordingId: confirmation.recordingId,
                        disposition: "not_ready",
                        reason: probe.reason ?? "Full-HD playback not yet confirmed",
                    });
                }
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    database.postponeConfirmation(confirmation.attemptId, reason, now);
                    results.push({ recordingId: confirmation.recordingId, disposition: "verification_retry_scheduled", reason });
                }
            }
        }); } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // Authentication failure must not cause a new browser/login attempt
            // every 30 seconds, nor erase the uncertain acceptance state.
            for (const confirmation of providerDue) database.postponeConfirmation(confirmation.attemptId, reason, now);
            results.push({ disposition: "verification_login_retry_scheduled", uploadProvider: provider, reason });
        }
        }
        // Contradictory recordings (upload states without any remote identity
        // and without a pending confirmation) go to manual review.
        for (const contradiction of database.listUploadContradictions()) {
            database.transition(
                contradiction.id,
                contradiction.state,
                "blocked",
                "upload state without remote identity or pending confirmation; manual review required",
                now,
            );
            results.push({ recordingId: contradiction.id, disposition: "manual_review" });
        }
        return { checkedAt: now.toISOString(), results };
    } finally {
        database.close();
        if (config.comparisonTrialOnly) await writeComparisonReport(config);
    }
}
