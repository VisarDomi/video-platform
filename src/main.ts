import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import * as os from "os";
import logger from "./core/logger.js";
import { PORT, FRONTEND_DIST_PATH } from "./core/config.js";
import videoApiRouter from "./api/video.routes.js";
import hlsRouter from "./api/hls.routes.js";
import { initializeCache } from "./services/cache/memory/cache.service.js";
import { initializeHlsCache } from "./services/cache/memory/hls.service.js";
import { API, FILE_NAMES, LOGS, MISC } from "./core/constants.js";

const logServerInfo = () => {
    const networkInterfaces = os.networkInterfaces();
    Object.keys(networkInterfaces).forEach((ifaceName) => {
        networkInterfaces[ifaceName]?.forEach((iface: os.NetworkInterfaceInfo) => {
            if (iface.family === MISC.NETWORK_INTERFACE_IPV4 && !iface.internal) {
                logger.info(LOGS.MESSAGES.LAN_ACCESS(iface.address, PORT));
            }
        });
    });
};

// Profiling store
const profilingData: { method: string; path: string; status: number; duration: number }[] = [];
const MAX_PROFILING_ENTRIES = 100;

function profilingMiddleware(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();

    res.on("finish", () => {
        const url = req.originalUrl;
        const isProfiledRoute = url.startsWith("/api/") || url.startsWith("/hls/");
        const isExcluded = url === "/api/profiling";

        if (isProfiledRoute && !isExcluded) {
            const end = process.hrtime.bigint();
            const duration = Number(end - start) / 1e6; // in milliseconds

            profilingData.unshift({
                method: req.method,
                path: url,
                status: res.statusCode,
                duration: parseFloat(duration.toFixed(3)),
            });

            if (profilingData.length > MAX_PROFILING_ENTRIES) {
                profilingData.pop();
            }
        }
    });

    next();
}

async function startServer() {
    const app = express();

    app.use(profilingMiddleware);
    app.use(cors());
    app.use(express.json({ limit: API.JSON_LIMIT }));

    if (!FRONTEND_DIST_PATH) {
        logger.error("FATAL ERROR: frontendDistPath is not configured. Exiting.");
        process.exit(1);
    }

    app.get("/api/profiling", (_req: Request, res: Response) => {
        res.json(profilingData);
    });

    app.use(express.static(FRONTEND_DIST_PATH));
    app.use("/api", videoApiRouter);
    app.use("/", hlsRouter);
    app.get(/.*/, (_req: Request, res: Response) => {
        res.sendFile(path.join(FRONTEND_DIST_PATH, FILE_NAMES.INDEX_HTML));
    });

    initializeCache();
    initializeHlsCache();

    app.listen(PORT, API.HOST, () => {
        logServerInfo();
    });
}

void startServer().catch((err: any) => {
    logger.error("Failed to start server", { err });
    process.exit(1);
});
