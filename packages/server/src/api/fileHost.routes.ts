import { Router } from "express";
import { FileHostDownloads, filePage } from "../services/fileHostDownloads.js";

// A file host's download queue, under /api/<host>: what its browser extension calls.
export function createFileHostRoutes(queue: FileHostDownloads) {
    const { id, label } = queue.host;
    const router = Router();
    router.get(`/api/${id}/health`, async (_req, res) => {
        res.set("Cache-Control", "no-store");
        try { await queue.get(""); res.json({ service: `video-platform-${id}`, version: 1 }); }
        catch { res.status(503).json({ error: `${label} queue unavailable` }); }
    });
    router.post(`/api/${id}/downloads`, async (req, res) => {
        // Cross-origin website scripts cannot enqueue work. The Safari background owns the handoff.
        const origin = req.get("origin");
        if (req.get("X-Video-Download") !== "1" || (origin && !/^(safari-web-extension|moz-extension|chrome-extension):\/\//.test(origin))) {
            res.status(403).json({ error: `Use the ${label} Safari extension` }); return;
        }
        try { filePage(queue.host, req.body?.url); }
        catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
        try { res.status(202).json(await queue.enqueue(req.body.url)); }
        catch { res.status(503).json({ error: "PC download queue unavailable; tap to retry" }); }
    });
    router.get(`/api/${id}/downloads/:id`, async (req, res) => {
        res.set("Cache-Control", "no-store");
        const job = await queue.get(req.params.id);
        if (!job) { res.status(404).json({ error: "Unknown download" }); return; }
        res.json(job);
    });
    return router;
}
