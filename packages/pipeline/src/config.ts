import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSitesFile, parseUplink, type UplinkSetting } from "sdk";
import { providerFolders, sitesFilePath, systemBrowserPath } from "shared";
import type { DiscoveryRoot } from "./discovery/inspectRecording.js";
import { CURRENT_PRODUCTION_VERSION } from "./domain/productionVersion.js";
import type { ActiveUploadProvider } from "./config/uploadProviders.js";
import { PipelineDatabase } from "./db/pipelineDatabase.js";

export interface PipelineConfig {
    readonly finalizationDatabasePath: string;
    readonly databasePath: string;
    readonly artifactsRoot: string;
    readonly stagingRoot: string;
    readonly manualStagingRoot: string;
    readonly discoveryRoots: readonly DiscoveryRoot[];
    readonly manualRemuxRoots: readonly DiscoveryRoot[];
    readonly uploadTimeZone: string;
    readonly serverUrl: string;
    readonly browserProfilePath: string;
    readonly chromiumExecutablePath: string;
    readonly credentialsFilePath: string;
    readonly uploadProvider?: ActiveUploadProvider;
    readonly cleanupEnabled: boolean;
    readonly networkUploadsEnabled: boolean;
    readonly automaticShortsEnabled?: boolean;
    readonly comparisonTrialOnly?: boolean;
    readonly comparisonSelectionFile?: string;
    // The sites file's "uplink" section: a second network uploads leave from, reached by a
    // carrier drive. Absent (null or undefined): only home uploads, nothing converts ahead.
    readonly uplink?: UplinkSetting | null;
}

const dataRoot = process.env.VIDEO_SERVICES_DATA_ROOT
    ?? path.join(os.homedir(), ".local", "share", "video-services");
const databasePath = process.env.VIDEO_PIPELINE_DB
    ?? path.join(dataRoot, "pipeline", "pipeline.sqlite");
// A persistent service owns its own profile, beside its database. General agent
// browsing must never contend for its singleton lock or cookie-storage backend.
const browserProfilePath = process.env.VIDEO_PIPELINE_BROWSER_PROFILE
    ?? path.join(path.dirname(databasePath), "browser");
const artifactsRoot = process.env.VIDEO_PIPELINE_ARTIFACTS_ROOT
    ?? process.env.VIDEO_PIPELINE_STAGING
    ?? path.join(dataRoot, "pipeline", "artifacts");

// The sites whose recordings the pipeline uploads: every site the sites file lists, in its
// order (a disabled site records nothing new, but its recordings still upload). Read when
// first needed, so commands that never look for recordings do not need the file.
let sources: string[] | undefined;
export function sourceSiteIds(): readonly string[] {
    if (!sources) {
        const file = sitesFilePath();
        let text: string;
        try { text = readFileSync(file, "utf8"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            throw new Error(`${file}: no sites file; the pipeline reads the sites it uploads from it`);
        }
        sources = parseSitesFile(text, file).map((site) => site.id);
    }
    return sources;
}

// The sites file's optional "uplink" section, read when first needed.
let uplink: UplinkSetting | null | undefined;
export function uplinkSetting(): UplinkSetting | null {
    if (uplink === undefined) {
        const file = sitesFilePath();
        let text: string;
        try { text = readFileSync(file, "utf8"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            text = "{}";
        }
        uplink = parseUplink(text, file);
    }
    return uplink;
}

// The source sites a configuration covers, in order: its discovery roots' sites.
export function sourcesOf(config: Pick<PipelineConfig, "discoveryRoots">): string[] {
    return [...new Set(config.discoveryRoots.map((root) => root.provider))];
}

// Roots come from the shared layout module: the single source of truth.
const discoveryRoots = (): DiscoveryRoot[] => sourceSiteIds().map((provider) => ({
    provider,
    sourceKind: "edited",
    path: providerFolders(provider).edited,
}));

const manualRemuxRoots = (): DiscoveryRoot[] => sourceSiteIds().flatMap((provider) => {
    const folders = providerFolders(provider);
    return [
        { provider, sourceKind: "downloader", path: folders.downloaded },
        { provider, sourceKind: "edited", path: folders.edited },
    ];
});

export const pipelineConfig: PipelineConfig = {
    finalizationDatabasePath: process.env.VIDEO_FINALIZATION_DB
        ?? path.join(dataRoot, "finalization.sqlite"),
    databasePath,
    artifactsRoot,
    stagingRoot: path.join(artifactsRoot, CURRENT_PRODUCTION_VERSION),
    manualStagingRoot: path.join(artifactsRoot, CURRENT_PRODUCTION_VERSION, "manual"),
    get discoveryRoots() { return discoveryRoots(); },
    get manualRemuxRoots() { return manualRemuxRoots(); },
    get uplink() { return uplinkSetting(); },
    serverUrl: process.env.VIDEO_SERVER_URL ?? "https://127.0.0.1:9999",
    browserProfilePath,
    chromiumExecutablePath: systemBrowserPath(),
    credentialsFilePath: process.env.VIDEO_UPLOAD_PROVIDERS_FILE
        ?? path.join(os.homedir(), ".config", "video-services", "upload-providers.json"),
    uploadTimeZone: process.env.VIDEO_PIPELINE_UPLOAD_TIMEZONE ?? "Europe/Tirane",
    cleanupEnabled: process.env.VIDEO_PIPELINE_CLEANUP === "1",
    automaticShortsEnabled: true,
    comparisonTrialOnly: false,
    comparisonSelectionFile: process.env.VIDEO_PIPELINE_SELECTION_FILE ?? path.join(dataRoot, "pipeline", "test-videos.txt"),
    networkUploadsEnabled: process.env.VIDEO_PIPELINE_NETWORK_UPLOADS === "1",
};

// The active destination is campaign intent in SQLite (upload-provider
// command), read at the operation boundary so a switch applies to the next
// upload without restarting the worker. The credentials file holds secrets only.
export function activeUploadProvider(config: Pick<PipelineConfig, "uploadProvider" | "databasePath">): ActiveUploadProvider {
    if (config.uploadProvider) return config.uploadProvider;
    const database = new PipelineDatabase(config.databasePath);
    try { return database.getActiveUploadProvider(); } finally { database.close(); }
}
