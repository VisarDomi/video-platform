import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { CampaignProviderFilter } from "../domain/types.js";
import { TargetCatalogResolver } from "../provenance/targetResolver.js";
import { CampaignWorker } from "../campaign/campaignWorker.js";
import { uploadOne } from "./uploadOne.js";

export function configureCampaign(
    config: PipelineConfig,
    provider: CampaignProviderFilter,
    monthlyUploadLimitBytes: number,
): unknown {
    const database = new PipelineDatabase(config.databasePath);
    try {
        return database.configureCampaign(provider, monthlyUploadLimitBytes);
    } finally {
        database.close();
    }
}

export function setCampaignRunning(config: PipelineConfig, running: boolean): unknown {
    const database = new PipelineDatabase(config.databasePath);
    try {
        return database.setCampaignState(running ? "running" : "paused");
    } finally {
        database.close();
    }
}

export function campaignStatus(config: PipelineConfig): unknown {
    const database = new PipelineDatabase(config.databasePath);
    try {
        const control = database.getCampaignControl();
        return {
            ...control,
            systemdUnitInstalled: false,
            cleanupEnabled: config.cleanupEnabled,
            networkUploadsEnabled: config.networkUploadsEnabled,
            counts: Object.entries(Object.groupBy(database.list(), (recording) => recording.state))
                .map(([state, recordings]) => ({ state, count: recordings?.length ?? 0 })),
            provenanceReviewRequired: database.listProvenanceReview().length,
            uploadConfirmationsDue: database.dueUploadConfirmations().length,
        };
    } finally {
        database.close();
    }
}

export async function campaignStep(config: PipelineConfig): Promise<unknown> {
    const database = new PipelineDatabase(config.databasePath);
    try {
        const recovery = database.recoverInterruptedUploads();
        const resolver = await TargetCatalogResolver.load({
            targetFiles: config.targetFiles,
            tangoAliasesPath: config.tangoAliasesPath,
        });
        const worker = new CampaignWorker(
            database,
            config,
            resolver,
            config.networkUploadsEnabled
                ? (recordingId, monthlyUploadLimitBytes) => uploadOne(recordingId, {
                    ...config,
                    monthlyUploadLimitBytes,
                }, { modelSelection: "automatic-known" })
                : undefined,
        );
        return { recovery, step: await worker.step() };
    } finally {
        database.close();
    }
}
