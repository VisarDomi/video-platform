import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import https from "https";
import * as os from "os";
import logger from "./core/logger.js";
import { PORT, FRONTEND_DIST_PATH, configureProviders } from "./core/config.js";
import videoApiRouter from "./api/video.routes.js";
import hlsRouter from "./api/hls.routes.js";
import { createListRoutes } from "./api/providers/list-routes.js";
import { createPhoneSessionRoutes, phoneSessionDependencies } from "./api/providers/phone-session.routes.js";
import { startAliasRefresh } from "./services/aliasRefreshService.js";
import { captureSiteIds, loadServerSites } from "./sites.js";
import { startMediaIntegrityFinalizer } from "./services/hls/mediaIntegrityFinalizer.js";
import { startDiskSpaceMonitor } from "./services/diskSpaceMonitor.js";
import { startLibraryIndexes } from "./services/video/library-index.js";
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

  // Every site in the sites file; a missing or invalid file stops the server here.
  const sites = await loadServerSites();
  // The recordings served (/api/videos, /hls, finalization, the disk check): every
  // capture site's; a request without a provider means the first.
  configureProviders(captureSiteIds(sites));
  const listSites = sites.flatMap((site) => site.instance.catalog
    ? [{ id: site.id, label: site.label, log: site.context.log, listPath: site.context.paths.downloadList, catalog: site.instance.catalog }]
    : []);

  startAliasRefresh(listSites);
  startMediaIntegrityFinalizer();
  startDiskSpaceMonitor();
  startLibraryIndexes();

  // /api/<site>/{list,add,remove,member,exists,resolve} for every site with a catalog.
  for (const site of listSites) {
    app.use("/", createListRoutes({ id: site.id, filePath: site.listPath, catalog: site.catalog }));
  }
  // /api/<site>/phone-session for every site whose auth provisions a phone's own sessions.
  const authSites = sites.filter((site) => site.instance.auth);
  for (const site of authSites) {
    const { auth } = site.instance;
    if (!auth?.provisionDevice) continue;
    const provisionDevice = auth.provisionDevice.bind(auth);
    const acknowledgeDevice = auth.acknowledgeDevice?.bind(auth);
    app.use("/", createPhoneSessionRoutes(site,
      phoneSessionDependencies(site, { provisionDevice, acknowledgeDevice }, authSites[0].id)));
  }
  app.use("/api", videoApiRouter);
  app.use("/", hlsRouter);

  const frontendAssetsPath = path.join(FRONTEND_DIST_PATH, "assets") + path.sep;
  app.use(express.static(FRONTEND_DIST_PATH, {
    setHeaders: (res, filePath) => {
      if (filePath.startsWith(frontendAssetsPath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));

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
