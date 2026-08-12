import { pipelineConfig } from "./config.js";
import { PipelineDatabase } from "./db/pipelineDatabase.js";
import { createDryRunUploadPlan } from "./upload/dryRunPlan.js";
import { applyDiscovery, planDiscovery } from "./discovery/discover.js";
import { readFinalizationContract } from "./discovery/finalizationContract.js";
import { remuxOne } from "./commands/remuxOne.js";

function usage(): never {
    throw new Error("Usage: pipeline <status|discover-plan|discover --apply|remux-one --recording PATH|retry ID|upload-plan>\nNo command performs uploads or cleanup.");
}

async function main(): Promise<void> {
    const command = process.argv[2];
    if (!["status", "discover-plan", "discover", "remux-one", "retry", "upload-plan"].includes(command ?? "")) usage();
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
        console.log(JSON.stringify(await remuxOne(args[1], pipelineConfig), null, 2));
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
            console.log(JSON.stringify({
                mode: "ledger-write-only",
                ...applyDiscovery(database, plan),
            }, null, 2));
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
