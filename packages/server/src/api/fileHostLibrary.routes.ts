import { Router } from "express";
import { MP4Library } from "../services/video/mp4Library.js";
import { MP4RenameError } from "../services/video/mp4Identity.js";
import { originalVideoContentType } from "../services/video/originalVideo.js";

// A file host's local library: the list and change feed (/api/videos?provider=<host>), renames,
// and byte-range playback of the original files (/media/<host>/...).
export function createFileHostLibraryRoutes(id: string, label: string, library: MP4Library) {
    const router = Router();
    router.get(["/api/videos", "/api/videos/changes"], async (req, res, next) => {
        // Another host's library answers it (fileHosts.ts ends with the error for none).
        if (req.query.provider !== id) { next(); return; }
        res.set("Cache-Control", "no-store");
        try {
            if (req.path === "/api/videos") { res.json(await library.videos(typeof req.query.after === "string" ? req.query.after : undefined)); return; }
            const since = req.query.since === undefined ? undefined : Number(req.query.since);
            const wait = Math.min(25, Math.max(0, Number(req.query.wait) || 0)) * 1000;
            const controller = new AbortController();
            res.on("close", () => controller.abort());
            const result = await library.changes(Number.isSafeInteger(since) ? since : undefined,
                typeof req.query.epoch === "string" ? req.query.epoch : undefined, wait, controller.signal);
            if (!res.destroyed) res.json(result);
        } catch { if (!res.headersSent && !res.destroyed) res.status(503).json({ error: `${label} library unavailable` }); }
    });
    router.get(`/api/${id}/files/:id`, async (req, res) => {
        const video = await library.videoById(req.params.id);
        res.set("Cache-Control", "no-store");
        if (!video) { res.status(404).json({ error: "The video no longer exists" }); return; }
        res.json({ video, epoch: library.epoch, revision: library.currentRevision });
    });
    router.post(`/api/${id}/files/:id/rename`, async (req, res) => {
        if (req.get("Origin") || req.get("X-Video-Library") !== "1") { res.status(403).json({ error: `Use ${label} local to rename videos` }); return; }
        try {
            const video = await library.renameFile(req.params.id, req.body?.filename, req.body?.name);
            res.json({ video, epoch: library.epoch, revision: library.currentRevision });
        }
        catch (error) {
            if (error instanceof MP4RenameError) { res.status(error.status).json({ error: error.message }); return; }
            console.error(`${label} rename could not complete:`, (error as Error).message);
            res.status(503).json({ error: "Rename could not be confirmed. Reconnect and check the filename." });
        }
    });
    router.get(`/media/${id}/id/:id`, async (req, res) => {
        const file = await library.fileById(req.params.id);
        if (!file) { res.status(404).end(); return; }
        res.type(originalVideoContentType(file)).set("Cache-Control", "private, no-cache");
        res.sendFile(file, { dotfiles: "deny", acceptRanges: true, cacheControl: false }, error => {
            if (!error || req.aborted || res.destroyed) return;
            if (res.headersSent) { res.destroy(); return; }
            for (const [name, value] of Object.entries((error as { headers?: Record<string, string> }).headers ?? {})) res.set(name, value);
            res.status((error as { status?: number }).status ?? 500).end();
        });
    });
    router.get(`/media/${id}/:filename`, async (req, res) => {
        const file = await library.file(req.params.filename);
        if (!file) { res.status(404).end(); return; }
        // sendFile streams bytes with HEAD, ETag, If-Range and single byte-range support.
        // Never read a multi-gigabyte MP4 into Node memory or remux it for playback.
        res.type(originalVideoContentType(file)).set("Cache-Control", "private, no-cache");
        res.sendFile(file, { dotfiles: "deny", acceptRanges: true, cacheControl: false }, error => {
            if (!error || req.aborted || res.destroyed) return;
            if (res.headersSent) { res.destroy(); return; }
            for (const [name, value] of Object.entries((error as { headers?: Record<string, string> }).headers ?? {})) res.set(name, value);
            res.status((error as { status?: number }).status ?? 500).end();
        });
    });
    return router;
}

// After every host's library: a list request for no configured host.
export function createFileHostLibraryFallback(ids: readonly string[]) {
    const router = Router();
    router.get(["/api/videos", "/api/videos/changes"], (_req, res) => {
        res.set("Cache-Control", "no-store").status(400).json({ error: `Expected provider=${ids.join("|")}` });
    });
    return router;
}
