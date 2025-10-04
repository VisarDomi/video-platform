// src/server.ts
import express, { Request, Response } from "express"; // <-- FIX: Added Request, Response types
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import * as os from "os"; // <-- FIX: Changed to namespace import
import logger from "./logger.js";
import { PORT } from "./config.js";
import videoApiRouter from "./api/video.routes.js";
import streamingRouter from "./api/streaming.routes.js";

// --- Helper Functions ---
const logServerInfo = () => {
    logger.info(`✓ Tango Dashboard server running.`);
    logger.info(`   Listening on port: ${PORT}`);
    const networkInterfaces = os.networkInterfaces();
    Object.keys(networkInterfaces).forEach((ifaceName) => {
        // FIX: Added explicit type for 'iface'
        networkInterfaces[ifaceName]?.forEach((iface: os.NetworkInterfaceInfo) => {
            if ("IPv4" === iface.family && !iface.internal) {
                logger.info(`   LAN Access: http://${iface.address}:${PORT}`);
            }
        });
    });
};

// --- Path Setup ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Express App Setup ---
const app = express();
app.use(cors());
app.use(express.json());
// FIX: Point static server to the new client build output directory
app.use(express.static(path.join(__dirname, "..", "..", "dist", "client")));

// --- Routers ---
app.use("/api", videoApiRouter);
app.use("/", streamingRouter);

// --- Serve Frontend ---
// This catch-all route ensures that any direct navigation to a frontend route
// is handled by the single-page application.
// FIX: Added types and renamed unused 'req'
app.get(/.*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "..", "..", "dist", "client", "index.html"));
});

// --- Start Server & Services ---
app.listen(PORT, "0.0.0.0", () => {
    logServerInfo();
});
