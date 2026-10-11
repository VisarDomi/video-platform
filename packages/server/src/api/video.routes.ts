import { Router, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import os from "os";
import zlib from "zlib";
import { libraryIndex } from "../services/video/library-index.js";
import * as moveService from "../services/video/move.service.js";
import * as editService from "../services/video/edit.service.js";
import * as playlistAuthority from "../services/hls/playlistAuthority.js";
import * as utils from "../core/utils.js";
import { getProviderPaths } from "../core/config.js";
import logger from "../core/logger.js";
import { DESTINATIONS, API } from "../core/constants.js";
import * as types from "../core/types.js";

const router = Router();

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

function knownProvider(provider: string): boolean {
    try { getProviderPaths(provider); return true; } catch { return false; }
}

function sendJSON(req: Request, res: Response, json: Buffer, gzip?: Buffer): void {
    res.set({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", Vary: "Accept-Encoding" });
    if (/\bgzip\b/.test(req.get("Accept-Encoding") ?? "") && json.length > 1024) {
        res.set("Content-Encoding", "gzip");
        res.end(gzip ?? zlib.gzipSync(json));
    } else {
        res.end(json);
    }
}

// The recordings of a provider, from the library index (services/video/library-index.ts):
// the whole list (encoded once per revision, gzipped, 304 when unchanged), or with `after`
// only the names after it.
router.get("/videos", async (req, res) => {
    const provider = (req.query.provider as string) || "tango";
    if (!knownProvider(provider)) return res.status(400).json({ error: `Unknown provider: ${provider}` });
    try {
        const index = libraryIndex(provider);
        const after = req.query.after as string | undefined;
        if (after) return sendJSON(req, res, Buffer.from(JSON.stringify(await index.videos(after))));
        const encoded = await index.encodedList();
        const etag = `W/"${index.epoch}-${encoded.revision}"`;
        res.set("ETag", etag);
        if (req.get("If-None-Match") === etag) return res.status(304).end();
        sendJSON(req, res, encoded.json, encoded.gzip);
    } catch (error: any) {
        logger.error("Failed to retrieve videos", { error });
        res.status(500).json({ error: "Failed to retrieve videos" });
    }
});

// What changed since a revision: `?provider=&epoch=&since=&wait=<seconds, at most 25>`. With
// nothing new it waits for the next change (long polling). A client without a revision, of
// another epoch (the server restarted) or too far behind gets the whole list instead.
router.get("/videos/changes", async (req, res) => {
    const provider = (req.query.provider as string) || "tango";
    if (!knownProvider(provider)) return res.status(400).json({ error: `Unknown provider: ${provider}` });
    try {
        const since = req.query.since === undefined ? undefined : Number(req.query.since);
        const wait = Math.min(25, Math.max(0, Number(req.query.wait) || 0)) * 1000;
        let closed = false;
        req.on("close", () => { closed = true; });
        const changes = await libraryIndex(provider).changes(Number.isSafeInteger(since) ? since : undefined, req.query.epoch as string | undefined, wait);
        if (closed) return;
        sendJSON(req, res, Buffer.from(JSON.stringify(changes)));
    } catch (error: any) {
        logger.error("Failed to retrieve video changes", { error });
        res.status(500).json({ error: "Failed to retrieve video changes" });
    }
});

router.post("/edit", async (req, res) => {
    const { filename, segments, provider }: { filename: string; segments: string[], provider?: string } = req.body;
    const targetProvider = provider || "tango";

    if (!filename || !segments || segments.length === 0) {
        logger.warn(`[api/edit] rejected: filename=${filename ?? "missing"} segments=${segments?.length ?? "missing"} provider=${targetProvider}`);
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_FILENAME_SEGMENTS_REQUIRED);
    }

    logger.debug(`[api/edit] request: filename=${filename} segments=${segments.length} provider=${targetProvider}`);

    try {
        const ref = await utils.resolveVideo(filename, targetProvider);
        await editService.editVideo(ref, segments);
        await libraryIndex(targetProvider).refresh();
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
        const activeDownloadFolders = new Set([
            path.join(paths.downloaded, ".active"),
            path.join(paths.downloaded, ".pending"),
        ]);
        const roots = [
            ...(scope === "all" || scope === "downloads" ? [{ scope: "downloads", path: paths.downloaded }] : []),
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

router.post("/videos/:filename/:destination", async (req, res) => {
    const { filename, destination } = req.params as { filename: string; destination: types.Destination };
    const provider = (req.query.provider as string) || "tango";

    if (!filename || !(destination === DESTINATIONS.TRASH || destination === DESTINATIONS.ORIGINAL || destination === DESTINATIONS.EDITED)) {
        return res.status(400).send(API.MESSAGES.INVALID_REQUEST_DESTINATION);
    }
    try {
        const ref = await utils.resolveVideo(filename, provider);
        await moveService.moveVideo(ref, destination);
        await libraryIndex(provider).refresh();
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
