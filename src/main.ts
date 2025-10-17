import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import * as os from "os";
import crypto from "crypto";
import logger from "./core/logger.js";
import { PORT, FRONTEND_DIST_PATH } from "./core/config.js";
import videoApiRouter from "./api/video.routes.js";
import hlsRouter from "./api/hls.routes.js";
import { initializeCache } from "./services/cache/memory/cache.service.js";
import { initializeHlsCache } from "./services/cache/memory/hls.service.js";
import * as profilingService from "./services/profiling.service.js";
import { API, FILE_NAMES, LOGS, MISC } from "./core/constants.js";

declare module "express-serve-static-core" {
    interface Request {
        id: string;
    }
}

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

// Profiling store for the frontend modal
const profilingData: { method: string; path: string; status: number; duration: number }[] = [];
const MAX_PROFILING_ENTRIES = 100;

function requestStartMiddleware(req: Request, _res: Response, next: NextFunction) {
    req.id = crypto.randomUUID();
    profilingService.start(req.id);
    next();
}

function responseFinishMiddleware(req: Request, res: Response, next: NextFunction) {
    res.on("finish", () => {
        const url = req.originalUrl;
        const isProfiledRoute = url.startsWith("/api/") || url.startsWith("/hls/");
        const isExcluded = url === "/api/profiling";

        if (isProfiledRoute && !isExcluded) {
            const session = profilingService.end(req.id);
            if (session) {
                const totalDurationMs = Number(session.laps[session.laps.length - 1].time - session.start) / 1e6;

                // For frontend modal
                profilingData.unshift({
                    method: req.method,
                    path: url,
                    status: res.statusCode,
                    duration: parseFloat(totalDurationMs.toFixed(3)),
                });
                if (profilingData.length > MAX_PROFILING_ENTRIES) {
                    profilingData.pop();
                }

                // For detailed backend log file
                profilingService.logSlowRequest({ method: req.method, path: url, status: res.statusCode }, session);
            }
        }
    });

    next();
}

async function startServer() {
    const app = express();

    app.use(requestStartMiddleware);
    app.use(responseFinishMiddleware);

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
