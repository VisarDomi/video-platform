// src/server.ts
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import * as os from "os";
import logger from "./logger.js";
import { PORT, FRONTEND_DIST_PATH } from "./config.js";
import videoApiRouter from "./api/video.routes.js";
import hlsRouter from "./api/hls.routes.js";
import { startPlaylistFixerWorker } from "./services/video.service.js";

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

async function startServer() {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: "10mb" }));
    app.use(express.static(FRONTEND_DIST_PATH!));
    app.use("/api", videoApiRouter);
    app.use("/", hlsRouter);
    app.get(/.*/, (_req: Request, res: Response) => {
        res.sendFile(path.join(FRONTEND_DIST_PATH!, "index.html"));
    });
    app.listen(PORT, "0.0.0.0", () => {
        logServerInfo();
        startPlaylistFixerWorker().catch((err) => logger.error("Initial playlist fixer worker failed", { err }));
        setInterval(() => {
            startPlaylistFixerWorker().catch((err) => logger.error("Periodic playlist fixer worker failed", { err }));
        }, 5 * 60 * 1000);
    });
}

void startServer().catch((err) => {
    logger.error("Failed to start server", { err });
    process.exit(1);
});