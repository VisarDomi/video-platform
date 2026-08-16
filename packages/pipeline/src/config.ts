import os from "node:os";
import path from "node:path";
import { providerFolders } from "shared";
import type { DiscoveryRoot } from "./discovery/inspectRecording.js";

export interface PipelineConfig {
    readonly finalizationDatabasePath: string;
    readonly databasePath: string;
    readonly stagingRoot: string;
    readonly discoveryRoots: readonly DiscoveryRoot[];
    readonly manualRemuxRoots: readonly DiscoveryRoot[];
    readonly uploadTimeZone: string;
    readonly monthlyUploadLimitBytes: number;
    readonly serverUrl: string;
    readonly browserProfilePath: string;
    readonly chromiumExecutablePath: string;
    readonly credentialsFilePath: string;
    readonly cleanupEnabled: boolean;
    readonly networkUploadsEnabled: boolean;
}

const dataRoot = process.env.VIDEO_SERVICES_DATA_ROOT
    ?? path.join(os.homedir(), ".local", "share", "video-services");
const providers = ["tango", "fc2", "sc"];

// Roots come from the shared layout module: the single source of truth.
const discoveryRoots: DiscoveryRoot[] = providers.map((provider) => ({
    provider,
    sourceKind: "edited",
    path: providerFolders(provider).edited,
}));

const manualRemuxRoots: DiscoveryRoot[] = providers.flatMap((provider) => {
    const folders = providerFolders(provider);
    return [
        { provider, sourceKind: "downloader", path: folders.downloaded },
        { provider, sourceKind: "edited", path: folders.edited },
    ];
});

export const pipelineConfig: PipelineConfig = {
    finalizationDatabasePath: process.env.VIDEO_FINALIZATION_DB
        ?? path.join(dataRoot, "finalization.sqlite"),
    databasePath: process.env.VIDEO_PIPELINE_DB
        ?? path.join(dataRoot, "pipeline", "pipeline.sqlite"),
    stagingRoot: process.env.VIDEO_PIPELINE_STAGING
        ?? path.join(dataRoot, "pipeline", "artifacts"),
    discoveryRoots,
    manualRemuxRoots,
    serverUrl: process.env.VIDEO_SERVER_URL ?? "https://127.0.0.1:7973",
    browserProfilePath: process.env.VIDEO_XVIDEOS_BROWSER_PROFILE
        ?? path.join(os.homedir(), ".config", "chromium-agent"),
    chromiumExecutablePath: process.env.VIDEO_CHROMIUM_PATH ?? "/usr/bin/chromium",
    credentialsFilePath: process.env.VIDEO_XVIDEOS_ENV_FILE
        ?? path.resolve(import.meta.dirname, "..", "..", ".env"),
    uploadTimeZone: process.env.VIDEO_PIPELINE_UPLOAD_TIMEZONE ?? "Europe/Tirane",
    monthlyUploadLimitBytes: Number.parseInt(
        process.env.VIDEO_PIPELINE_MONTHLY_UPLOAD_BYTES ?? "600000000000",
        10,
    ),
    cleanupEnabled: process.env.VIDEO_PIPELINE_CLEANUP !== "0",
    networkUploadsEnabled: process.env.VIDEO_PIPELINE_NETWORK_UPLOADS === "1",
};
