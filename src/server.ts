import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import * as os from "os";
import logger from "./logger.js";
import { PORT, FRONTEND_DIST_PATH } from "./config.js"; // <-- Import FRONTEND_DIST_PATH
import videoApiRouter from "./api/video.routes.js";
import streamingRouter from "./api/streaming.routes.js";

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

// --- Express App Setup ---
const app = express();
app.use(cors());
app.use(express.json());

// Why: The server now serves static files from the path defined in the .env file.
// This decouples the backend from the frontend's location.
app.use(express.static(FRONTEND_DIST_PATH!));

// --- Routers ---
app.use("/api", videoApiRouter);
app.use("/", streamingRouter);

// --- Serve Frontend ---
// This catch-all route ensures that any direct navigation to a frontend route
// is handled by the single-page application.
// Why: This must also point to the index.html inside the configured dist path.
app.get(/.*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(FRONTEND_DIST_PATH!, "index.html"));
});

// --- Start Server & Services ---
app.listen(PORT, "0.0.0.0", () => {
    logServerInfo();
});
