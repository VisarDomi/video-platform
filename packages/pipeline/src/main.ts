import { journalPriority, sitesFilePath } from "shared";
import { markStopping } from "./shutdown.js";
import { pipelineConfig, sourceSiteIds, type PipelineConfig } from "./config.js";
import { PipelineDatabase } from "./db/pipelineDatabase.js";
import { createDryRunUploadPlan } from "./upload/dryRunPlan.js";
import { applyDiscovery, planDiscovery } from "./discovery/discover.js";
import { readFinalizationContract } from "./discovery/finalizationContract.js";
import { ensureFinalizedRemuxOne } from "./commands/ensureFinalizedRemuxOne.js";
import { describeOne } from "./commands/describeOne.js";
import { uploadOne } from "./commands/uploadOne.js";
import { probeUplink } from "./uplink/uplinkCommands.js";
import { reconcileDueUploads } from "./commands/reconcileUploads.js";
import { TargetCatalogResolver } from "./provenance/targetResolver.js";
import { PipelineOrchestrator } from "./scheduler/orchestrator.js";
import { createDefaultStages } from "./stages/defaultStages.js";
import {
    campaignStatus,
    campaignStep,
    configureCampaign,
    setCampaignRunning,
} from "./commands/campaign.js";
import type { CampaignProviderFilter } from "./domain/types.js";
import { runCampaignWorker } from "./commands/runCampaignWorker.js";
import { parseRemuxOneArguments } from "./commands/remuxOneArguments.js";
import { selectComparisonFile, writeComparisonReport } from "./commands/comparisonTrial.js";
import { assertUploadProvider } from "./config/uploadProviders.js";
import { checkRejectedPhrases } from "./metadata/rejectedPhraseCheck.js";
import { retryRecording } from "./commands/retryRecording.js";
import { contentProfile, initContentProfile } from "./contentProfile.js";
import { readFile } from "node:fs/promises";
import { parseDestinations } from "sdk";

function usage(): never {
    throw new Error([
        "Usage: pipeline <command>",
        "Commands:",
        "  status | discover-plan | discover --apply",
        "  remux-one --recording PATH [--upscale1080p | --upscale1440p]",
        "  describe-one --recording ID",
        "  process-one --apply | provenance-refresh --apply | provenance-review",
        "  provenance-set ID --streamer-id ID --alias NAME --streamer-url URL [--alias-url URL]",
        "  review | retry ID | upload-plan",
        "  upload-one --recording ID [--uplink ID [--carrier-dir DIR]] --apply | reconcile-uploads --apply",
        "  uplink-probe [--carrier-dir DIR]",
        "  upload-provider [--provider DESTINATION --apply]",
        "  metadata-check [--provider DESTINATION]",
        "  plus each destination's own commands (its sites-file entry's \"commands\" package)",
        "  campaign-configure --provider all|SITE [--daily-upload-bytes N] [--trial-per-provider N|none] --apply",
        "  campaign-resume --apply | campaign-pause --apply | campaign-status | campaign-step --apply",
        "  campaign-prepare --apply | campaign-select --file PATH --apply | comparison-report",
        "  campaign-worker (reserved for the future managed service)",
        "No command performs source cleanup. Network commands also require VIDEO_PIPELINE_NETWORK_UPLOADS=1.",
    ].join("\n"));
}

function option(args: readonly string[], name: string): string | null {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

function requireApply(args: readonly string[]): void {
    if (!args.includes("--apply")) throw new Error("This command mutates the pipeline ledger and requires --apply");
}

function assertCampaignIdle(config: PipelineConfig): void {
    const database = new PipelineDatabase(config.databasePath);
    try {
        if (database.campaignIsActive()) {
            throw new Error("The campaign worker is active; stop it first (systemctl --user stop video-pipeline) before running manual commands");
        }
    } finally {
        database.close();
    }
}

// A destination this deployment configures (the sites file's "destinations"): only such
// a destination can become the active one or be checked.
async function requireConfiguredDestination(requested: string): Promise<void> {
    assertUploadProvider(requested);
    const configured = parseDestinations(await readFile(sitesFilePath(), "utf8"), sitesFilePath());
    if (!configured.some((destination) => destination.id === requested)) {
        throw new Error(`The sites file names no destination "${requested}"`);
    }
}

// "all", or one of the sites the sites file lists.
function campaignProvider(value: string | null): CampaignProviderFilter {
    const choices = ["all", ...sourceSiteIds()];
    if (value !== null && choices.includes(value)) return value;
    throw new Error(`Campaign provider must be ${choices.length > 1 ? `${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}` : choices[0]}`);
}

// The CLI commands a destination adds: its sites-file entry names a package whose
// `commands` maps command names to handlers.
async function destinationCommand(command: string): Promise<((args: readonly string[]) => Promise<void>) | null> {
    if (!command) return null;
    for (const entry of parseDestinations(await readFile(sitesFilePath(), "utf8"), sitesFilePath())) {
        if (!entry.commands) continue;
        const module = await import(entry.commands) as { commands?: Record<string, (args: readonly string[]) => Promise<void>> };
        // Own names only: "toString" or "constructor" is no command.
        if (module.commands && Object.hasOwn(module.commands, command)) return module.commands[command];
    }
    return null;
}

async function main(): Promise<void> {
    const command = process.argv[2];
    if (!["status", "discover-plan", "discover", "remux-one", "describe-one", "process-one", "provenance-refresh",
        "provenance-review", "provenance-set", "review", "retry", "upload-plan", "upload-one",
        "reconcile-uploads", "campaign-configure", "campaign-resume", "campaign-pause",
        "campaign-status", "campaign-step", "campaign-worker", "campaign-prepare", "campaign-select", "comparison-report",
        "upload-provider", "metadata-check", "uplink-probe"].includes(command ?? "")) {
        // Not a core command: a destination's own (named by its sites-file entry), or none.
        const run = await destinationCommand(command ?? "");
        if (!run) {
            console.error(`No destination in ${sitesFilePath()} provides the command ${JSON.stringify(command ?? "")}`);
            usage();
        }
        await run(process.argv.slice(3));
        return;
    }
    // The deployment's content profile (named by its sites file) drives descriptions and
    // upload metadata. The worker and the stage commands stop here, before touching
    // anything, without it; session upkeep and reports run either way.
    if (!await initContentProfile() && ["campaign-worker", "campaign-step", "describe-one", "process-one",
        "metadata-check", "retry", "upload-one"].includes(command ?? "")) contentProfile();
    if (command === "campaign-prepare") {
        requireApply(process.argv.slice(3));
        assertCampaignIdle(pipelineConfig);
        console.log(JSON.stringify(await setCampaignRunning(pipelineConfig, false, true), null, 2));
        return;
    }
    if (command === "campaign-select") {
        const args = process.argv.slice(3);
        requireApply(args);
        assertCampaignIdle(pipelineConfig);
        const filePath = option(args, "--file");
        if (!filePath || filePath.startsWith("--")) throw new Error("campaign-select requires --file PATH");
        console.log(JSON.stringify(await selectComparisonFile(pipelineConfig, filePath), null, 2));
        return;
    }
    if (command === "comparison-report") {
        console.log(JSON.stringify(await writeComparisonReport(pipelineConfig), null, 2));
        return;
    }
    if (command === "discover-plan") {
        const finalizationContract = readFinalizationContract(pipelineConfig.finalizationDatabasePath);
        const plan = await planDiscovery(pipelineConfig.discoveryRoots);
        const finalized = plan.filter((result) => result.status === "finalized");
        const excluded = plan.filter((result) => result.status === "excluded");
        console.log(JSON.stringify({
            mode: "read-only",
            finalizationContract,
            finalized: finalized.length,
            excluded: excluded.length,
            finalizedBySource: Object.entries(Object.groupBy(
                finalized,
                (result) => `${result.recording.provider}:${result.recording.sourceKind}`,
            )).map(([source, results]) => ({ source, count: results?.length ?? 0 })),
            excludedByReason: Object.entries(Object.groupBy(excluded, (result) => result.reason))
                .map(([reason, results]) => ({ reason, count: results?.length ?? 0 })),
            excludedSamples: excluded.slice(0, 20),
        }, null, 2));
        return;
    }
    if (command === "remux-one") {
        assertCampaignIdle(pipelineConfig);
        const args = parseRemuxOneArguments(process.argv.slice(3));
        console.log(JSON.stringify(
            await ensureFinalizedRemuxOne(args.recordingPath, pipelineConfig, args.upscaleMode),
            null,
            2,
        ));
        return;
    }
    if (command === "describe-one") {
        assertCampaignIdle(pipelineConfig);
        const args = process.argv.slice(3);
        const recordingId = option(args, "--recording");
        if (!recordingId) usage();
        console.log(JSON.stringify(await describeOne(recordingId, pipelineConfig), null, 2));
        return;
    }
    if (command === "upload-one") {
        assertCampaignIdle(pipelineConfig);
        const args = process.argv.slice(3);
        requireApply(args);
        const recordingId = option(args, "--recording");
        if (!recordingId) usage();
        const uplink = option(args, "--uplink") ?? undefined;
        const carrierRoot = option(args, "--carrier-dir") ?? undefined;
        if (carrierRoot && !uplink) throw new Error("--carrier-dir needs --uplink");
        console.log(JSON.stringify(await uploadOne(recordingId, pipelineConfig, { uplink, carrierRoot }), null, 2));
        return;
    }
    if (command === "uplink-probe") {
        console.log(JSON.stringify(await probeUplink(pipelineConfig, option(process.argv.slice(3), "--carrier-dir") ?? undefined), null, 2));
        return;
    }
    if (command === "reconcile-uploads") {
        requireApply(process.argv.slice(3));
        console.log(JSON.stringify(await reconcileDueUploads(pipelineConfig), null, 2));
        return;
    }
    if (command === "campaign-configure") {
        const args = process.argv.slice(3);
        requireApply(args);
        const provider = campaignProvider(option(args, "--provider"));
        if (args.includes("--monthly-upload-bytes")) throw new Error("--monthly-upload-bytes is gone: the allowance is daily (--daily-upload-bytes)");
        const rawLimit = option(args, "--daily-upload-bytes");
        const limit = rawLimit === null ? undefined : Number(rawLimit);
        const rawTrial = option(args, "--trial-per-provider");
        if (args.includes("--trial-per-provider") && (rawTrial === null || rawTrial.startsWith("--"))) {
            throw new Error("--trial-per-provider requires a positive integer or none");
        }
        const trial = rawTrial === null ? undefined : rawTrial === "none" ? null : Number(rawTrial);
        console.log(JSON.stringify(configureCampaign(pipelineConfig, provider, limit, trial), null, 2));
        return;
    }
    if (command === "campaign-resume" || command === "campaign-pause") {
        requireApply(process.argv.slice(3));
        console.log(JSON.stringify(await setCampaignRunning(pipelineConfig, command === "campaign-resume"), null, 2));
        return;
    }
    if (command === "campaign-status") {
        console.log(JSON.stringify(campaignStatus(pipelineConfig), null, 2));
        return;
    }
    if (command === "campaign-step") {
        requireApply(process.argv.slice(3));
        console.log(JSON.stringify(await campaignStep(pipelineConfig), null, 2));
        return;
    }
    if (command === "campaign-worker") {
        if (process.env.VIDEO_PIPELINE_SERVICE_MODE !== "1") {
            throw new Error("campaign-worker is reserved for the managed service and requires VIDEO_PIPELINE_SERVICE_MODE=1");
        }
        const controller = new AbortController();
        const stop = () => { markStopping(); controller.abort(); };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        await runCampaignWorker(pipelineConfig, controller.signal);
        return;
    }
    const database = new PipelineDatabase(pipelineConfig.databasePath);
    try {
        if (command === "status") {
            const counts = Object.entries(Object.groupBy(database.list(), (recording) => recording.state))
                .map(([state, recordings]) => ({ state, count: recordings?.length ?? 0 }));
            console.log(JSON.stringify({
                databasePath: pipelineConfig.databasePath,
                finalizationContract: readFinalizationContract(pipelineConfig.finalizationDatabasePath),
                integrity: database.integrityCheck(),
                productionVersion: database.getProductionVersion(),
                productionRollovers: database.listProductionRollovers(),
                artifactsRoot: pipelineConfig.artifactsRoot,
                stagingRoot: pipelineConfig.stagingRoot,
                manualStagingRoot: pipelineConfig.manualStagingRoot,
                cleanupEnabled: pipelineConfig.cleanupEnabled,
                networkUploadsEnabled: pipelineConfig.networkUploadsEnabled,
                counts,
                provenanceReviewRequired: database.listProvenanceReview().length,
                uploadConfirmationsDue: database.dueUploadConfirmations().length,
            }, null, 2));
            return;
        }
        if (command === "discover") {
            if (!process.argv.slice(3).includes("--apply")) {
                throw new Error("discover writes only the pipeline ledger and requires --apply");
            }
            if (!readFinalizationContract(pipelineConfig.finalizationDatabasePath)) {
                throw new Error("Historical server finalization is incomplete; refusing to trust finalized roots");
            }
            const plan = await planDiscovery(pipelineConfig.discoveryRoots);
            const resolver = TargetCatalogResolver.load({ serverUrl: pipelineConfig.serverUrl });
            console.log(JSON.stringify({
                mode: "ledger-write-only",
                ...(await applyDiscovery(database, plan, resolver)),
            }, null, 2));
            return;
        }
        if (command === "process-one") {
            assertCampaignIdle(pipelineConfig);
            requireApply(process.argv.slice(3));
            const orchestrator = new PipelineOrchestrator(
                database,
                createDefaultStages(pipelineConfig.stagingRoot, pipelineConfig),
                `pipeline-cli-${process.pid}`,
            );
            console.log(JSON.stringify(await orchestrator.processOne(), null, 2));
            return;
        }
        if (command === "provenance-refresh") {
            requireApply(process.argv.slice(3));
            const resolver = TargetCatalogResolver.load({ serverUrl: pipelineConfig.serverUrl });
            let resolved = 0;
            let reviewRequired = 0;
            for (const recording of database.list()) {
                const resolution = await resolver.resolve(recording);
                const provenance = database.saveProvenance(recording.id,
                    database.getProvenanceOverride(recording.provider, resolution.observedIdentifier) ?? resolution);
                if (provenance.status === "review_required") reviewRequired++;
                else {
                    resolved++;
                    if (database.get(recording.id)?.state === "provenance_review_required") {
                        database.transition(recording.id, "provenance_review_required", "described", "provenance resolver succeeded");
                    }
                }
            }
            console.log(JSON.stringify({ resolved, reviewRequired }, null, 2));
            return;
        }
        if (command === "provenance-review") {
            const items = database.listProvenanceReview();
            const groups = Object.entries(Object.groupBy(items, (item) => {
                const provider = database.get(item.recordingId)?.provider ?? "unknown";
                return `${provider}\0${item.observedIdentifier}`;
            })).map(([key, group]) => {
                const [provider, observedIdentifier] = key.split("\0");
                return {
                    provider,
                    observedIdentifier,
                    recordingCount: group?.length ?? 0,
                    reason: group?.[0]?.reason ?? null,
                    recordingIds: group?.map((item) => item.recordingId) ?? [],
                    samplePaths: group?.slice(0, 5).map((item) => database.get(item.recordingId)?.sourcePath) ?? [],
                };
            });
            console.log(JSON.stringify(groups, null, 2));
            return;
        }
        if (command === "provenance-set") {
            const args = process.argv.slice(3);
            const id = args[0];
            const streamerId = option(args, "--streamer-id");
            const alias = option(args, "--alias");
            const streamerUrl = option(args, "--streamer-url");
            if (!id || !streamerId || !alias || !streamerUrl) usage();
            console.log(JSON.stringify(database.saveManualProvenance(id, {
                streamerId,
                alias,
                streamerUrl,
                aliasUrl: option(args, "--alias-url"),
            }), null, 2));
            return;
        }
        if (command === "review") {
            const blocked: Array<Record<string, unknown>> = [];
            const providerRemoved: Array<Record<string, unknown>> = [];
            for (const recording of database.list().filter((item) => item.state === "blocked")) {
                const removals = database.providerRemovals(recording.id);
                const isProviderRemoval = Boolean(
                    recording.blockReason && removals.some((entry) => recording.blockReason!.startsWith(`${entry.provider} removed video ${entry.remoteId} `)),
                );
                const item = {
                    recordingId: recording.id,
                    provider: recording.provider,
                    state: recording.state,
                    reason: recording.blockReason,
                    sourcePath: recording.sourcePath,
                    resolutionArtifacts: database.listResolutionReviewArtifacts(recording.id),
                };
                if (isProviderRemoval) providerRemoved.push(item);
                else blocked.push(item);
            }
            const provenance = database.listProvenanceReview().map((item) => {
                const recording = database.get(item.recordingId);
                return {
                    recordingId: item.recordingId,
                    provider: recording?.provider ?? "unknown",
                    observedIdentifier: item.observedIdentifier,
                    reason: item.reason,
                    sourcePath: recording?.sourcePath ?? null,
                };
            });
            // Shape-split pieces under a minute: not uploaded, waiting for a person.
            const manualPieces = database.listManualPieces().map((piece) => ({
                recordingId: piece.recordingId,
                part: piece.part,
                durationSeconds: piece.durationSeconds,
                segmentIndexes: piece.segmentIndexes,
                sourceDimensions: piece.sourceDimensions,
                sourcePath: database.get(piece.recordingId)?.sourcePath ?? null,
            }));
            console.log(JSON.stringify({ blocked, providerRemoved, provenanceReview: provenance, manualPieces }, null, 2));
            return;
        }
        if (command === "upload-provider") {
            const args = process.argv.slice(3);
            const requested = option(args, "--provider");
            if (requested !== null) {
                requireApply(args);
                await requireConfiguredDestination(requested);
                if (database.campaignIsActive()) throw new Error("Stop the campaign worker before switching the upload provider");
                database.setActiveUploadProvider(requested);
            }
            console.log(JSON.stringify({
                activeUploadProvider: database.getActiveUploadProvider(),
                history: database.listUploadProviderEvents(),
            }, null, 2));
            return;
        }
        if (command === "metadata-check") {
            // Read-only: composed metadata versus every phrase the provider
            // rejected before. The campaign applies the same check before upload.
            const requested = option(process.argv.slice(3), "--provider") ?? database.getActiveUploadProvider();
            await requireConfiguredDestination(requested);
            const candidates = database.list().filter((recording) => !["upload_verified", "cleanup_eligible"].includes(recording.state)
                && database.getUploadMetadata(recording.id));
            const findings = [];
            for (const recording of candidates) {
                const verdict = await checkRejectedPhrases(database, recording.id, requested);
                if (verdict.kind !== "clean") findings.push({ recordingId: recording.id, state: recording.state, ...verdict });
            }
            console.log(JSON.stringify({
                provider: requested,
                rejectedPhrases: database.listRejectedPhrases(requested),
                checked: candidates.length,
                findings,
            }, null, 2));
            return;
        }
        if (command === "retry") {
            const recordingId = process.argv[3];
            if (!recordingId) throw new Error("retry requires a recording ID");
            console.log(JSON.stringify(retryRecording(database, recordingId), null, 2));
            return;
        }
        console.log(JSON.stringify({
            mode: "dry-run",
            networkRequests: 0,
            quotaMutations: 0,
            items: await createDryRunUploadPlan(
                database,
                new Date(),
                pipelineConfig.uploadTimeZone,
                database.getCampaignControl().dailyUploadLimitBytes,
                pipelineConfig.stagingRoot,
                database.getActiveUploadProvider(),
            ),
        }, null, 2));
    } finally {
        database.close();
    }
}

void main().catch((error: unknown) => {
    console.error(journalPriority("error", 2) + (error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exitCode = 1;
});
