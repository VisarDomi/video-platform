import { Router } from "express";
import { BunkrDownloads, bunkrPage } from "../services/bunkrDownload.js";

export function createBunkrRoutes(queue = new BunkrDownloads()) {
    const router = Router();
    router.get("/api/bunkr/health", async (_req, res) => {
        res.set("Cache-Control", "no-store");
        try { await queue.get(""); res.json({ service: "video-platform-bunkr", version: 1 }); }
        catch { res.status(503).json({ error: "Bunkr queue unavailable" }); }
    });
    router.post("/api/bunkr/downloads", async (req, res) => {
        // Cross-origin website scripts cannot enqueue work. The Safari background owns the handoff.
        const origin = req.get("origin");
        if (req.get("X-Video-Download") !== "1" || (origin && !/^(safari-web-extension|moz-extension|chrome-extension):\/\//.test(origin))) {
            res.status(403).json({ error: "Use the Bunkr Safari extension" }); return;
        }
        try { bunkrPage(req.body?.url); }
        catch { res.status(400).json({ error: "Expected a Bunkr /f/ video URL" }); return; }
        try { res.status(202).json(await queue.enqueue(req.body.url)); }
        catch { res.status(503).json({ error: "PC download queue unavailable; tap to retry" }); }
    });
    router.get("/api/bunkr/downloads/:id", async (req, res) => {
        res.set("Cache-Control", "no-store");
        const job = await queue.get(req.params.id);
        if (!job) { res.status(404).json({ error: "Unknown download" }); return; }
        res.json(job);
    });
    return router;
}
