import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import * as os from "os";
import logger from "./core/logger.js";
import { PORT, FRONTEND_DIST_PATH } from "./core/config.js";
import videoApiRouter from "./api/video.routes.js";
import hlsRouter from "./api/hls.routes.js";
import { initializeCache } from "./services/cache/memory/cache.service.js";
import { initializeHlsCache } from "./services/cache/memory/hls.service.js";

const logServerInfo = () => {
    const networkInterfaces = os.networkInterfaces();
    Object.keys(networkInterfaces).forEach((ifaceName) => {
        networkInterfaces[ifaceName]?.forEach((iface: os.NetworkInterfaceInfo) => {
            if (iface.family === "IPv4" && !iface.internal) {
                logger.info(`LAN Access: http://${iface.address}:${PORT}`);
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

    initializeCache();
    initializeHlsCache();

    app.listen(PORT, "0.0.0.0", () => {
        logServerInfo();
    });
}

void startServer().catch((err: any) => {
    logger.error("Failed to start server", { err });
    process.exit(1);
});
