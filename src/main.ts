import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import https from "https";
import * as os from "os";
import logger from "./core/logger.js";
import { PORT, FRONTEND_DIST_PATH } from "./core/config.js";
import videoApiRouter from "./api/video.routes.js";
import hlsRouter from "./api/hls.routes.js";
import fc2Router from "./api/fc2.routes.js";
import scRouter from "./api/sc.routes.js";
import tangoListRouter from "./api/tango-list.routes.js";
import tlRouter from "./api/tl.routes.js";
import tlProxyRouter from "./api/tl-proxy.routes.js";
import mp4StreamingRouter from "./api/mp4-streaming.routes.js";
import { startTokenWatcher } from "./services/tango/tokenManager.js";
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

  // Initialize tl token watcher
  startTokenWatcher();

  // Register routes
  app.use("/api", tlProxyRouter);
  app.use("/api", tlRouter);
  app.use("/", fc2Router); // fc2Router handles /fc2 and /api/fc2
  app.use("/", scRouter); // scRouter handles /sc and /api/sc
  app.use("/", tangoListRouter); // tangoListRouter handles /tango-list and /api/tango-list
  app.use("/api", videoApiRouter);
  app.use("/", mp4StreamingRouter);
  app.use("/", hlsRouter);

  // Serve static frontend
  app.use(express.static(FRONTEND_DIST_PATH));

  // Fallback to index.html for SPA routing
  app.get(/.*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(FRONTEND_DIST_PATH, FILE_NAMES.INDEX_HTML));
  });

  const mkcertPath = path.join(os.homedir(), ".local/share/mkcert/pwa");
  const keyPath = path.join(mkcertPath, "key.pem");
  const certPath = path.join(mkcertPath, "cert.pem");

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const sslOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    https.createServer(sslOptions, app).listen(PORT, API.HOST, () => {
      logServerInfo();
    });
  } else {
    logger.warn(
      "SSL certs not found at " + mkcertPath + ", falling back to HTTP",
    );
    app.listen(PORT, API.HOST, () => {
      logServerInfo();
    });
  }
}

void startServer().catch((err: any) => {
  logger.error("Failed to start server", { err });
  process.exit(1);
});
