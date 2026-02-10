import { Router } from "express";
import logger from "../core/logger.js";
import * as tangoApi from "../services/tango/apiClient.js";

const router = Router();

const DOWNLOADER_API = "http://localhost:7974";

// --- Stream listing ---
router.get("/tl/streams", async (_req, res) => {
    try {
        const result = await tangoApi.fetchStreamers(50);
        res.json(result);
    } catch (error: any) {
        logger.error("[TL] Failed to fetch streams", { error: error.message });
        res.status(500).json({ error: "Failed to fetch streams" });
    }
});

// --- Social actions ---
router.post("/tl/follow", async (req, res) => {
    const { streamerId } = req.body;
    if (!streamerId) return res.status(400).json({ error: "streamerId required" });
    const ok = await tangoApi.follow(streamerId);
    res.json({ success: ok });
});

router.post("/tl/unfollow", async (req, res) => {
    const { streamerId } = req.body;
    if (!streamerId) return res.status(400).json({ error: "streamerId required" });
    const ok = await tangoApi.unfollow(streamerId);
    res.json({ success: ok });
});

router.post("/tl/block", async (req, res) => {
    const { streamerId } = req.body;
    if (!streamerId) return res.status(400).json({ error: "streamerId required" });
    const ok = await tangoApi.block(streamerId);
    res.json({ success: ok });
});

// --- Download proxy ---
router.post("/tl/download/start", async (req, res) => {
    const { masterPlaylistUrl, alias, streamerId } = req.body;
    if (!masterPlaylistUrl || !alias || !streamerId) {
        return res.status(400).json({ error: "masterPlaylistUrl, alias, streamerId required" });
    }
    try {
        const response = await fetch(`${DOWNLOADER_API}/api/download/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ masterPlaylistUrl, alias, streamerId }),
        });
        const data = await response.json();
        res.json(data);
    } catch (error: any) {
        logger.error("[TL] Failed to proxy download/start", { error: error.message });
        res.status(502).json({ error: "Download service unavailable" });
    }
});

router.post("/tl/download/stop", async (req, res) => {
    const { alias } = req.body;
    if (!alias) return res.status(400).json({ error: "alias required" });
    try {
        const response = await fetch(`${DOWNLOADER_API}/api/download/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ alias }),
        });
        const data = await response.json();
        res.json(data);
    } catch (error: any) {
        logger.error("[TL] Failed to proxy download/stop", { error: error.message });
        res.status(502).json({ error: "Download service unavailable" });
    }
});

export default router;
