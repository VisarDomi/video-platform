// src/server.ts
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import * as os from "os";
import logger from "./logger.js";
import { PORT, FRONTEND_DIST_PATH } from "./config.js";
import videoApiRouter from "./api/video.routes.js";
import hlsRouter from "./api/hls.routes.js";
// WHY THE CHANGE: Import the new singleton service instance.
import { hlsService } from "./services/hls.service.js";

// --- Helper Functions ---
const logServerInfo = () => {
    logger.info(`✓ Tango Dashboard server running.`);
    logger.info(`   Listening on port: ${PORT}`);
    const networkInterfaces = os.networkInterfaces();
    Object.keys(networkInterfaces).forEach((ifaceName) => {
        networkInterfaces[ifaceName]?.forEach((iface: os.NetworkInterfaceInfo) => {
            if ("IPv4" === iface.family && !iface.internal) {
                logger.info(`   LAN Access: http://${iface.address}:${PORT}`);
            }
        });
    });
};

// --- Main Server Function ---
async function startServer() {
    // --- Initialize Services ---
    // WHY THE CHANGE: The new initialize() method is synchronous and non-blocking.
    // It sets up the background queue and returns immediately.
    hlsService.initialize();

    // --- Express App Setup ---
    const app = express();
    app.use(cors());
    // WHY THE CHANGE: Increase the JSON body size limit. The default is 100kb.
    // The frontend sends a list of all video identifiers to get details,
    // which can exceed 100kb if the video library is large, causing a
    // "PayloadTooLargeError". Setting a higher limit (e.g., 10mb) fixes this.
    app.use(express.json({ limit: "10mb" }));

    // Serve static frontend files
    app.use(express.static(FRONTEND_DIST_PATH!));

    // --- Routers ---
    app.use("/api", videoApiRouter);
    app.use("/", hlsRouter);

    // --- Serve Frontend Catch-all ---
    app.get(/.*/, (_req: Request, res: Response) => {
        res.sendFile(path.join(FRONTEND_DIST_PATH!, "index.html"));
    });

    // --- Start Listening ---
    app.listen(PORT, "0.0.0.0", () => {
        logServerInfo();
    });
}

// --- Start the server ---
void startServer().catch((err) => {
    logger.error("Failed to start server", { err });
    process.exit(1);
});
