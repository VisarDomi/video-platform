// src/server.ts
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import * as os from "os";
import logger from "./logger.js";
import { PORT, FRONTEND_DIST_PATH } from "./config.js";
import videoApiRouter from "./api/video.routes.js";
import hlsRouter from "./api/hls.routes.js"; // Renamed from streamingRouter
import { initializeHlsService } from "./services/hls.service.js"; // Import the HLS service initializer

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
    await initializeHlsService();

    // --- Express App Setup ---
    const app = express();
    app.use(cors()); // Kept for good practice, even if not strictly needed now
    app.use(express.json());

    // Serve static frontend files
    app.use(express.static(FRONTEND_DIST_PATH!));

    // --- Routers ---
    app.use("/api", videoApiRouter);
    app.use("/", hlsRouter); // Use the new HLS router

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
