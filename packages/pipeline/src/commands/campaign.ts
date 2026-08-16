import type { PipelineConfig } from "../config.js";
import { readXvideosCredentials } from "../config/secrets.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { CampaignProviderFilter } from "../domain/types.js";
import { TargetCatalogResolver } from "../provenance/targetResolver.js";
import { ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";
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
            systemdUnitInstalled: true,
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
        const resolver = TargetCatalogResolver.load({ serverUrl: config.serverUrl });
        let uploader: ChromiumXvideosUploader | undefined;
        if (config.networkUploadsEnabled) {
            const credentials = await readXvideosCredentials(config.credentialsFilePath);
            uploader = new ChromiumXvideosUploader({
                executablePath: config.chromiumExecutablePath,
                profilePath: config.browserProfilePath,
                leaveOpenOnFailure: false,
                ...credentials,
            });
        }
        const worker = new CampaignWorker(
            database,
            config,
            resolver,
            config.networkUploadsEnabled
                ? (recordingId, monthlyUploadLimitBytes) => uploadOne(recordingId, {
                    ...config,
                    monthlyUploadLimitBytes,
                })
                : undefined,
            uploader,
        );
        return { recovery, step: await worker.step() };
    } finally {
        database.close();
    }
}
