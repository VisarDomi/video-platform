import os from "node:os";
import path from "node:path";
import type { DiscoveryRoot } from "./discovery/inspectRecording.js";

const dataRoot = process.env.VIDEO_SERVICES_DATA_ROOT
    ?? path.join(os.homedir(), ".local", "share", "video-services");
const downloadsRoot = process.env.VIDEO_DOWNLOADS_ROOT
    ?? path.join(os.homedir(), "Videos", "downloads");
const providers = ["tango", "fc2", "sc"];

const discoveryRoots: DiscoveryRoot[] = providers.flatMap((provider) => [
    { provider, sourceKind: "downloader", path: path.join(downloadsRoot, provider, "downloader") },
    { provider, sourceKind: "edited", path: path.join(downloadsRoot, provider, "editor", "edited") },
]);

export const pipelineConfig = {
    databasePath: process.env.VIDEO_PIPELINE_DB
        ?? path.join(dataRoot, "pipeline", "pipeline.sqlite"),
    stagingRoot: process.env.VIDEO_PIPELINE_STAGING
        ?? path.join(dataRoot, "pipeline", "artifacts"),
    discoveryRoots,
    uploadTimeZone: process.env.VIDEO_PIPELINE_UPLOAD_TIMEZONE ?? "Europe/Tirane",
    monthlyUploadLimitBytes: Number.parseInt(
        process.env.VIDEO_PIPELINE_MONTHLY_UPLOAD_BYTES ?? "600000000000",
        10,
    ),
    cleanupEnabled: false as const,
    networkUploadsEnabled: false as const,
};
