import { pipelineConfig } from "./config.js";
import { PipelineDatabase } from "./db/pipelineDatabase.js";
import { createDryRunUploadPlan } from "./upload/dryRunPlan.js";
import { applyDiscovery, planDiscovery } from "./discovery/discover.js";
import { readFinalizationContract } from "./discovery/finalizationContract.js";
import { ensureFinalizedRemuxOne } from "./commands/ensureFinalizedRemuxOne.js";
import { describeOne } from "./commands/describeOne.js";
import { uploadOne } from "./commands/uploadOne.js";
import { reconcileDueUploads } from "./commands/reconcileUploads.js";
import { TargetCatalogResolver } from "./provenance/targetResolver.js";
import { PipelineOrchestrator } from "./scheduler/orchestrator.js";
import { createDefaultStages } from "./stages/defaultStages.js";
import { readSecretFile } from "./config/secrets.js";
import {
    campaignStatus,
    campaignStep,
    configureCampaign,
    setCampaignRunning,
} from "./commands/campaign.js";
import type { CampaignProviderFilter } from "./domain/types.js";
import { runCampaignWorker } from "./commands/runCampaignWorker.js";

function usage(): never {
    throw new Error([
        "Usage: pipeline <command>",
        "Commands:",
        "  status | discover-plan | discover --apply | remux-one --recording PATH",
        "  describe-one --recording ID",
        "  process-one --apply | provenance-refresh --apply | provenance-review",
        "  provenance-set ID --streamer-id ID --alias NAME --streamer-url URL [--alias-url URL]",
        "  model-set ID --from-env | model-set ID --stage-name NAME --gender VALUE --how VALUE --picture PATH",
        "  retry ID | upload-plan",
        "  upload-one --recording ID --apply | reconcile-uploads --apply",
        "  campaign-configure --provider all|tango|fc2|sc [--monthly-upload-bytes N] --apply",
        "  campaign-resume --apply | campaign-pause --apply | campaign-status | campaign-step --apply",
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

function campaignProvider(value: string | null): CampaignProviderFilter {
    if (value === "all" || value === "tango" || value === "fc2" || value === "sc") return value;
    throw new Error("Campaign provider must be all, tango, fc2, or sc");
}

async function main(): Promise<void> {
    const command = process.argv[2];
    if (!["status", "discover-plan", "discover", "remux-one", "describe-one", "process-one", "provenance-refresh",
        "provenance-review", "provenance-set", "model-set", "retry", "upload-plan", "upload-one",
        "reconcile-uploads", "campaign-configure", "campaign-resume", "campaign-pause",
        "campaign-status", "campaign-step", "campaign-worker"].includes(command ?? "")) usage();
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
        const args = process.argv.slice(3);
        if (args.length !== 2 || args[0] !== "--recording" || args[1] === "") usage();
        console.log(JSON.stringify(await ensureFinalizedRemuxOne(args[1], pipelineConfig), null, 2));
        return;
    }
    if (command === "describe-one") {
        const args = process.argv.slice(3);
        const recordingId = option(args, "--recording");
        if (!recordingId) usage();
        console.log(JSON.stringify(await describeOne(recordingId, pipelineConfig), null, 2));
        return;
    }
    if (command === "upload-one") {
        const args = process.argv.slice(3);
        requireApply(args);
        const recordingId = option(args, "--recording");
        if (!recordingId) usage();
        console.log(JSON.stringify(await uploadOne(recordingId, pipelineConfig), null, 2));
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
        const rawLimit = option(args, "--monthly-upload-bytes");
        const limit = rawLimit === null ? pipelineConfig.monthlyUploadLimitBytes : Number.parseInt(rawLimit, 10);
        console.log(JSON.stringify(configureCampaign(pipelineConfig, provider, limit), null, 2));
        return;
    }
    if (command === "campaign-resume" || command === "campaign-pause") {
        requireApply(process.argv.slice(3));
        console.log(JSON.stringify(setCampaignRunning(pipelineConfig, command === "campaign-resume"), null, 2));
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
        process.once("SIGINT", () => controller.abort());
        process.once("SIGTERM", () => controller.abort());
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
            requireApply(process.argv.slice(3));
            const orchestrator = new PipelineOrchestrator(
                database,
                createDefaultStages(pipelineConfig.stagingRoot),
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
        if (command === "model-set") {
            const args = process.argv.slice(3);
            const id = args[0];
            const recording = id ? database.get(id) : null;
            const provenance = id ? database.getProvenance(id) : null;
            if (!recording || !provenance?.streamerId) throw new Error("model-set requires a recording with resolved provenance");
            const secrets = args.includes("--from-env")
                ? await readSecretFile(pipelineConfig.credentialsFilePath)
                : {};
            const stageName = option(args, "--stage-name") ?? secrets.MODEL_STAGE_NAME;
            const gender = option(args, "--gender") ?? secrets.MODEL_GENDER;
            const howKnown = option(args, "--how") ?? secrets.MODEL_HOW;
            const profilePicture = option(args, "--picture") ?? secrets.MODEL_PROFILE_PICTURE;
            if (!stageName || !gender || !howKnown || !profilePicture) usage();
            console.log(JSON.stringify(database.saveStreamerModel({
                provider: recording.provider,
                streamerId: provenance.streamerId,
                stageName,
                gender,
                howKnown,
                profilePicture,
                xvideosModelId: option(args, "--xvideos-model-id"),
            }), null, 2));
            return;
        }
        if (command === "retry") {
            const recordingId = process.argv[3];
            if (!recordingId) throw new Error("retry requires a recording ID");
            console.log(JSON.stringify(database.retryFailed(recordingId), null, 2));
            return;
        }
        console.log(JSON.stringify({
            mode: "dry-run",
            networkRequests: 0,
            quotaMutations: 0,
            items: createDryRunUploadPlan(
                database,
                new Date(),
                pipelineConfig.uploadTimeZone,
                pipelineConfig.monthlyUploadLimitBytes,
            ),
        }, null, 2));
    } finally {
        database.close();
    }
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
