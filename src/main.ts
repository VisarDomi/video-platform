import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import * as os from "os";
import logger from "./core/logger.js";
import { PORT, FRONTEND_DIST_PATH } from "./core/config.js";
import videoApiRouter from "./api/video.routes.js";
import hlsRouter from "./api/hls.routes.js";
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

async function startServer() {
    const app = express();

    app.use(cors());
    app.use(express.json({ limit: API.JSON_LIMIT }));

    if (!FRONTEND_DIST_PATH) {
        logger.error("FATAL ERROR: frontendDistPath is not configured. Exiting.");
        process.exit(1);
    }

    app.use(express.static(FRONTEND_DIST_PATH));
    app.use("/api", videoApiRouter);
    app.use("/", hlsRouter);
    app.get(/.*/, (_req: Request, res: Response) => {
        res.sendFile(path.join(FRONTEND_DIST_PATH, FILE_NAMES.INDEX_HTML));
    });

    app.listen(PORT, API.HOST, () => {
        logServerInfo();
    });
}

void startServer().catch((err: any) => {
    logger.error("Failed to start server", { err });
    process.exit(1);
});