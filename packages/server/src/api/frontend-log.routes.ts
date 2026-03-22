import { Router } from "express";
import logger from "../core/logger.js";

const router = Router();

router.post("/api/log", (req, res) => {
    const { event, data } = req.body;
    if (!event || typeof event !== "string") {
        return res.status(400).end();
    }
    logger.info(`[Frontend] ${event}`, data ?? {});
    res.status(204).end();
});

export default router;
