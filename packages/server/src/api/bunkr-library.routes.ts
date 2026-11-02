import { Router } from "express";
import { MP4Library } from "../services/video/mp4Library.js";
import { MP4RenameError } from "../services/video/mp4Identity.js";
import { originalVideoContentType } from "../services/video/originalVideo.js";

export function createBunkrLibraryRoutes(library: MP4Library) {
    const router = Router();
    router.get(["/api/videos", "/api/videos/changes"], async (req, res) => {
        res.set("Cache-Control", "no-store");
        if (req.query.provider !== "bunkr") { res.status(400).json({ error: "Expected provider=bunkr" }); return; }
        try {
            if (req.path === "/api/videos") { res.json(await library.videos(typeof req.query.after === "string" ? req.query.after : undefined)); return; }
            const since = req.query.since === undefined ? undefined : Number(req.query.since);
            const wait = Math.min(25, Math.max(0, Number(req.query.wait) || 0)) * 1000;
            const controller = new AbortController();
            res.on("close", () => controller.abort());
            const result = await library.changes(Number.isSafeInteger(since) ? since : undefined,
                typeof req.query.epoch === "string" ? req.query.epoch : undefined, wait, controller.signal);
            if (!res.destroyed) res.json(result);
        } catch { if (!res.headersSent && !res.destroyed) res.status(503).json({ error: "Bunkr library unavailable" }); }
    });
    router.get("/api/bunkr/files/:id", async (req, res) => {
        const video = await library.videoById(req.params.id);
        res.set("Cache-Control", "no-store");
        if (!video) { res.status(404).json({ error: "The video no longer exists" }); return; }
        res.json({ video, epoch: library.epoch, revision: library.currentRevision });
    });
    router.post("/api/bunkr/files/:id/rename", async (req, res) => {
        if (req.get("Origin") || req.get("X-Video-Library") !== "1") { res.status(403).json({ error: "Use Bunkr local to rename videos" }); return; }
        try {
            const video = await library.renameFile(req.params.id, req.body?.filename, req.body?.name);
            res.json({ video, epoch: library.epoch, revision: library.currentRevision });
        }
        catch (error) {
            if (error instanceof MP4RenameError) { res.status(error.status).json({ error: error.message }); return; }
            console.error("Bunkr rename could not complete:", (error as Error).message);
            res.status(503).json({ error: "Rename could not be confirmed. Reconnect and check the filename." });
        }
    });
    router.get("/media/bunkr/id/:id", async (req, res) => {
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
    router.get("/media/bunkr/:filename", async (req, res) => {
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
