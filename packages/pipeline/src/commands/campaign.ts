import path from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import type { PipelineConfig } from "../config.js";
import { readXvideosCredentials } from "../config/secrets.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import type { CampaignProviderFilter } from "../domain/types.js";
import { TargetCatalogResolver } from "../provenance/targetResolver.js";
import { ChromiumXvideosUploader } from "../upload/chromiumXvideosUploader.js";
import { CampaignWorker } from "../campaign/campaignWorker.js";
import { uploadOne } from "./uploadOne.js";
import { CURRENT_PRODUCTION_VERSION } from "../domain/productionVersion.js";

function assertVersionedStagingRoot(artifactsRoot: string, stagingRoot: string): void {
    const root = path.resolve(artifactsRoot);
    const currentRoot = path.resolve(stagingRoot);
    if (path.dirname(currentRoot) !== root || path.basename(currentRoot) !== CURRENT_PRODUCTION_VERSION) {
        throw new Error(`Current staging root must be ${path.join(root, CURRENT_PRODUCTION_VERSION)}`);
    }
}

export function configureCampaign(
    config: PipelineConfig,
    provider: CampaignProviderFilter,
    monthlyUploadLimitBytes?: number,
    trialPerProvider?: number | null,
): unknown {
    const database = new PipelineDatabase(config.databasePath);
    try {
        return database.configureCampaign(provider,
            monthlyUploadLimitBytes ?? database.getCampaignControl().monthlyUploadLimitBytes,
            new Date(), trialPerProvider);
    } finally {
        database.close();
    }
}

async function archiveRetiredProductionFiles(
    artifactsRoot: string,
    currentStagingRoot: string,
    fromVersion: string,
    ownedPaths: readonly string[],
): Promise<{
    moved: number;
    alreadyArchived: number;
    alreadyMissing: number;
    skippedOutsideArtifactsRoot: number;
}> {
    if (!/^(?:legacy-)?production-v\d+$/.test(fromVersion)) {
        throw new Error(`Unsafe retired production version ${fromVersion}`);
    }
    const root = path.resolve(artifactsRoot);
    const currentRoot = path.resolve(currentStagingRoot);
    assertVersionedStagingRoot(root, currentRoot);
    const archiveRoot = path.join(root, fromVersion);
    const legacyRootEntries = fromVersion.startsWith("legacy-")
        ? await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
        })
        : [];
    const candidates = [...new Set([
        ...ownedPaths.map((candidate) => path.resolve(candidate)),
        ...legacyRootEntries
            .filter((entry) => entry.isFile() || entry.isSymbolicLink())
            .map((entry) => path.join(root, entry.name)),
    ])];
    let moved = 0;
    let alreadyArchived = 0;
    let alreadyMissing = 0;
    let skippedOutsideArtifactsRoot = 0;
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        const relative = path.relative(root, resolved);
        if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
            // Descriptor evidence can live outside the artifact root. It is
            // content-addressed and cannot collide with generation artifacts.
            skippedOutsideArtifactsRoot++;
            continue;
        }
        const parts = relative.split(path.sep);
        if (parts[0] === fromVersion) {
            const existingArchive = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            if (existingArchive) alreadyArchived++;
            else alreadyMissing++;
            continue;
        }
        // A file written into the new-version directory before activation is
        // still owned by the retiring database generation. Strip that leading
        // generation component when moving it into the old generation.
        const targetParts = /^(?:legacy-)?production-v\d+$/.test(parts[0]) ? parts.slice(1) : parts;
        const target = path.join(archiveRoot, ...targetParts);
        const entry = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (!entry) {
            const archived = await lstat(target).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            if (archived) alreadyArchived++;
            else alreadyMissing++;
            continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) {
            throw new Error(`Refusing to archive non-file retired pipeline path ${resolved}`);
        }
        const collision = await lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (collision) throw new Error(`Retired artifact archive collision at ${target}`);
        await mkdir(path.dirname(target), { recursive: true });
        await rename(resolved, target);
        moved++;
    }
    return { moved, alreadyArchived, alreadyMissing, skippedOutsideArtifactsRoot };
}

export async function setCampaignRunning(config: PipelineConfig, running: boolean): Promise<unknown> {
    const database = new PipelineDatabase(config.databasePath);
    try {
        if (!running) return {
            ...database.setCampaignState("paused"),
            productionVersion: database.getProductionVersion(),
            rollover: null,
        };
        assertVersionedStagingRoot(config.artifactsRoot, config.stagingRoot);
        const plan = database.planProductionRollover(CURRENT_PRODUCTION_VERSION);
        if (plan.required && database.getCampaignControl().state !== "paused") {
            throw new Error("Pause the old production generation before resuming the new version");
        }
        if (plan.required && (plan.leasedRecordingCount > 0 || plan.activeUploadCount > 0)) {
            throw new Error(
                `Cannot roll production versions while ${plan.leasedRecordingCount} recording(s) are leased `
                + `or ${plan.activeUploadCount} upload(s) are active`,
            );
        }
        let historySnapshotPath: string | null = null;
        if (plan.required) {
            if (!/^(?:legacy-)?production-v\d+$/.test(plan.fromVersion)) {
                throw new Error(`Unsafe retired production version ${plan.fromVersion}`);
            }
            const historyDirectory = path.join(path.dirname(config.databasePath), "history", plan.fromVersion);
            await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
            historySnapshotPath = path.join(historyDirectory, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.sqlite`);
            database.snapshotTo(historySnapshotPath);
            await chmod(historySnapshotPath, 0o600);
            const snapshot = await open(historySnapshotPath, "r+");
            try { await snapshot.sync(); } finally { await snapshot.close(); }
        }
        // The unversioned root is never a valid current-generation output
        // location. Archive its immediate files even if the active database
        // was recreated and therefore has no legacy rows left to trigger a
        // database rollover.
        const unversioned = await archiveRetiredProductionFiles(
            config.artifactsRoot,
            config.stagingRoot,
            "legacy-production-v1",
            [],
        );
        const retiredGeneration = plan.required
            ? await archiveRetiredProductionFiles(
                config.artifactsRoot,
                config.stagingRoot,
                plan.fromVersion,
                plan.ownedPaths,
            )
            : { moved: 0, alreadyArchived: 0, alreadyMissing: 0, skippedOutsideArtifactsRoot: 0 };
        const rollover = database.commitProductionRollover(CURRENT_PRODUCTION_VERSION);
        await mkdir(config.stagingRoot, { recursive: true });
        return {
            ...database.setCampaignState("running"),
            productionVersion: database.getProductionVersion(),
            rollover: {
                ...rollover,
                historySnapshotPath,
                artifactArchival: { unversioned, retiredGeneration },
            },
        };
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
            trial: database.getCampaignTrialProgress(),
            productionVersion: database.getProductionVersion(),
            productionRolloverRequired: database.getProductionVersion() !== CURRENT_PRODUCTION_VERSION,
            productionRollovers: database.listProductionRollovers(),
            artifactsRoot: config.artifactsRoot,
            stagingRoot: config.stagingRoot,
            manualStagingRoot: config.manualStagingRoot,
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
        if (database.getProductionVersion() !== CURRENT_PRODUCTION_VERSION) {
            if (database.getCampaignControl().state === "paused") {
                return {
                    recovery: [],
                    productionRolloverRequired: true,
                    step: {
                        disposition: "paused",
                        reviewRequired: database.listProvenanceReview().length,
                    },
                };
            }
            throw new Error(
                `Pipeline database is waiting for ${CURRENT_PRODUCTION_VERSION} rollover; run campaign-resume --apply`,
            );
        }
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
