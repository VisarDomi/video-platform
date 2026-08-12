import { Router } from "express";
import fs from "fs";
import path from "path";
import os from "os";
import * as retrieveService from "../services/video/retrieve.service.js";
import * as moveService from "../services/video/move.service.js";
import * as editService from "../services/video/edit.service.js";
import * as playlistAuthority from "../services/hls/playlistAuthority.js";
import { requestMediaIntegrity } from "../services/hls/mediaIntegrityFinalizer.js";
import { repairFailedMediaIntegrity } from "../services/hls/failedIntegrityRepair.js";
import * as utils from "../core/utils.js";
import { getProviderPaths } from "../core/config.js";
import logger from "../core/logger.js";
import { DESTINATIONS, API } from "../core/constants.js";
import * as types from "../core/types.js";

const router = Router();

async function resolvePipelineRecording(
    provider: string,
    sourceKind: string,
    filename: string,
): Promise<string> {
    if (path.basename(filename) !== filename || filename === "") {
        throw new Error("Invalid recording filename");
    }
    const providerPaths = getProviderPaths(provider);
    const root = sourceKind === "downloader"
        ? providerPaths.downloader
        : sourceKind === "edited" ? providerPaths.edited : null;
    if (!root) throw new Error("sourceKind must be downloader or edited");
    const recordingPath = path.join(root, filename);
    const stats = await fs.promises.lstat(recordingPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("Pipeline recording must be a directly owned directory");
    }
    return recordingPath;
}

router.get("/cert", (_req, res) => {
    try {
        const certPath = path.join(os.homedir(), ".local/share/mkcert", "rootCA.pem");
        const certFile = fs.readFileSync(certPath);
        res.set({
            "Content-Disposition": 'attachment; filename="rootCA.pem"',
            "Content-Type": "application/x-x509-ca-cert",
        });
        res.send(certFile);
    } catch (error: any) {
        logger.error("Failed to read rootCA.pem", { message: error.message });
        res.status(500).json({ error: "Certificate not found on server" });
    }
});

router.get("/videos", async (req, res) => {
    try {
        const provider = (req.query.provider as string) || "tango";
        const after = req.query.after as string | undefined;
        const videos = await retrieveService.getAllVideos(provider, after);
        res.json(videos);
    } catch (error: any) {
        logger.error("Failed to retrieve videos", { error });
        res.status(500).json({ error: "Failed to retrieve videos" });
    }
});

router.post("/edit", async (req, res) => {
    const { filename, segments, provider }: { filename: string; segments: string[], provider?: string } = req.body;
    const targetProvider = provider || "tango";

    if (!filename || !segments || segments.length === 0) {
        logger.warn(`[api/edit] rejected: filename=${filename ?? "missing"} segments=${segments?.length ?? "missing"} provider=${targetProvider}`);
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_FILENAME_SEGMENTS_REQUIRED);
    }

    logger.info(`[api/edit] request: filename=${filename} segments=${segments.length} provider=${targetProvider}`);

    try {
        const ref = await utils.resolveVideo(filename, targetProvider);
        await editService.editVideo(ref, segments);
        res.json({ success: true });
    } catch (error: any) {
        if (error.name === "FileNotFoundError") {
            return res.status(404).json({ success: false, error: error.message });
        }
        logger.error(`[api/edit] failed: filename=${filename} provider=${targetProvider}`, { message: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post("/videos/:filename/repair-playlist", async (req, res) => {
    const { filename } = req.params as { filename: string };
    const provider = (req.query.provider as string) || "tango";

    try {
        const ref = await utils.resolveVideo(filename, provider);
        logger.info(`[api/repair-playlist] request: filename=${filename} provider=${provider} path=${ref.dirPath}`);
        const result = await playlistAuthority.repairPlaylistDurations(ref.dirPath);
        res.json({ success: true, result });
    } catch (error: any) {
        if (error.name === "FileNotFoundError") {
            return res.status(404).json({ success: false, error: error.message });
        }
        logger.error(`[api/repair-playlist] failed: filename=${filename} provider=${provider}`, { message: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post("/videos/repair-playlists", async (req, res) => {
    const provider = (req.query.provider as string) || "tango";
    const scope = (req.query.scope as string) || "all";

    try {
        const paths = getProviderPaths(provider);
        const activeDownloadFolders = new Set([path.join(paths.downloader, ".active")]);
        const roots = [
            ...(scope === "all" || scope === "downloads" ? [{ scope: "downloads", path: paths.downloader }] : []),
            ...(scope === "all" || scope === "edited" ? [{ scope: "edited", path: paths.edited }] : []),
        ];

        if (roots.length === 0) {
            return res.status(400).json({ success: false, error: "scope must be all, downloads, or edited" });
        }

        logger.info("[api/repair-playlists] request", { provider, scope, roots: roots.map((root) => root.path) });
        const results = [];
        for (const root of roots) {
            const skipFolders = root.scope === "downloads" ? activeDownloadFolders : new Set<string>();
            results.push({ scope: root.scope, result: await playlistAuthority.repairPlaylistDurationsUnder(root.path, skipFolders) });
        }
        res.json({ success: true, provider, scope, results });
    } catch (error: any) {
        logger.error("[api/repair-playlists] failed", { provider, scope, message: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post("/pipeline/recordings/:provider/:sourceKind/:filename/repair-playlist", async (req, res) => {
    const { provider, sourceKind, filename } = req.params as {
        provider: string;
        sourceKind: string;
        filename: string;
    };
    try {
        const recordingPath = await resolvePipelineRecording(provider, sourceKind, filename);
        const result = await playlistAuthority.repairPlaylistDurations(recordingPath, { apply: true });
        res.json({ success: true, result });
    } catch (error: any) {
        logger.error("[api/pipeline/repair-playlist] failed", { provider, sourceKind, filename, message: error.message });
        res.status(400).json({ success: false, error: error.message });
    }
});

router.post("/pipeline/recordings/:provider/:sourceKind/:filename/integrity", async (req, res) => {
    const { provider, sourceKind, filename } = req.params as {
        provider: string;
        sourceKind: string;
        filename: string;
    };
    try {
        const recordingPath = await resolvePipelineRecording(provider, sourceKind, filename);
        const report = await requestMediaIntegrity(recordingPath, { revalidate: true });
        res.json({ success: true, report });
    } catch (error: any) {
        logger.error("[api/pipeline/integrity] failed", { provider, sourceKind, filename, message: error.message });
        res.status(400).json({ success: false, error: error.message });
    }
});

router.post("/pipeline/recordings/:provider/:sourceKind/:filename/repair-failed-integrity", async (req, res) => {
    const { provider, sourceKind, filename } = req.params as {
        provider: string;
        sourceKind: string;
        filename: string;
    };
    try {
        const recordingPath = await resolvePipelineRecording(provider, sourceKind, filename);
        const result = await repairFailedMediaIntegrity(recordingPath, {
            revalidate: async (target) => {
                const report = await requestMediaIntegrity(target, { revalidate: true, retryFailed: true });
                if (report.version !== 2) throw new Error("Revalidation returned a legacy integrity report");
                return { kind: "processed", report };
            },
        });
        res.json({ success: true, result });
    } catch (error: any) {
        logger.error("[api/pipeline/repair-failed-integrity] failed", {
            provider, sourceKind, filename, message: error.message,
        });
        res.status(400).json({ success: false, error: error.message });
    }
});

router.post("/videos/:filename/:destination", async (req, res) => {
    const { filename, destination } = req.params as { filename: string; destination: types.Destination };
    const provider = (req.query.provider as string) || "tango";

    if (!filename || !(destination === DESTINATIONS.TRASH || destination === DESTINATIONS.ORIGINAL || destination === DESTINATIONS.EDITED)) {
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_DESTINATION);
    }
    try {
        const ref = await utils.resolveVideo(filename, provider);
        await moveService.moveVideo(ref, destination);
        res.json({ success: true });
    } catch (error: any) {
        if (error.name === "FileNotFoundError") {
            return res.status(404).json({ success: false, error: error.message });
        }
        logger.error(`Error moving:`, { message: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
