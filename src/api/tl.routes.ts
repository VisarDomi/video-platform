import { Router } from "express";
import logger from "../core/logger.js";
import * as tangoApi from "../services/tango/apiClient.js";
import * as followingCache from "../services/tango/followingCache.js";
import * as utils from "../core/utils.js";

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

// --- Multi-broadcast (co-streamers) ---
router.post("/tl/multi-broadcast", async (req, res) => {
    const { streamId } = req.body;
    if (!streamId) return res.status(400).json({ error: "streamId required" });
    try {
        const streamers = await tangoApi.fetchMultiBroadcastStreamers(streamId);
        res.json(streamers);
    } catch (error: any) {
        logger.error("[TL] Failed to fetch multi-broadcast", { error: error.message });
        res.status(500).json({ error: "Failed to fetch multi-broadcast" });
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

// --- Live filename resolution ---
router.get("/tl/live-filenames", async (_req, res) => {
    try {
        const filenames = await utils.getLiveFilenames();
        res.json(filenames);
    } catch (error: any) {
        logger.error("[TL] Failed to get live filenames", { error: error.message });
        res.status(500).json({});
    }
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

router.post("/tl/download/active", async (req, res) => {
    const { aliases } = req.body;
    if (!Array.isArray(aliases)) return res.status(400).json({ error: "aliases must be an array" });
    try {
        const response = await fetch(`${DOWNLOADER_API}/api/download/active`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ aliases }),
        });
        const data = await response.json();
        res.json(data);
    } catch (error: any) {
        logger.error("[TL] Failed to proxy download/active", { error: error.message });
        res.status(502).json({ error: "Download service unavailable" });
    }
});

// --- Tango provider follow/unfollow (recorded videos) ---
router.get("/tango-follow/following", async (_req, res) => {
    try {
        const aliases = await followingCache.getFollowedAliases();
        res.json([...aliases]);
    } catch (error: any) {
        logger.error("[Tango] Failed to get following list", { error: error.message });
        res.json([]);
    }
});

router.post("/tango-follow/follow", async (req, res) => {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: "identifier required" });
    const ok = await followingCache.resolveAndFollow(identifier);
    res.json({ success: ok });
});

router.post("/tango-follow/unfollow", async (req, res) => {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: "identifier required" });
    const ok = await followingCache.resolveAndUnfollow(identifier);
    res.json({ success: ok });
});

export default router;
