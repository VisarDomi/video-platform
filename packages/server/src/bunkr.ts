import express from "express";
import cors from "cors";
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createBunkrRoutes } from "./api/bunkr.routes.js";
import { BunkrDownloads } from "./services/bunkrDownload.js";
import { MP4Library } from "./services/video/mp4Library.js";
import { createBunkrLibraryRoutes } from "./api/bunkr-library.routes.js";

// Independently restartable byte-copy queue; no capture, login, finalizer or upload worker imports.
const certificates = path.join(os.homedir(), ".local/share/mkcert/pwa");
const queue = new BunkrDownloads();
const library = new MP4Library(queue.directory);
void library.start().catch(error => console.error("Bunkr library startup:", error.message));
const app = express();
app.use(cors());
app.use(express.json({ limit: "4kb" }));
app.use(createBunkrRoutes(queue));
app.use(createBunkrLibraryRoutes(library));
const server = https.createServer({
    key: readFileSync(path.join(certificates, "key.pem")),
    cert: readFileSync(path.join(certificates, "cert.pem")),
}, app).listen(9998, "0.0.0.0", () => console.info("Bunkr download queue listening on HTTPS :9998"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    queue.stop(); server.close(); void library.stop();
    // systemd gives in-flight writes time to flush before enforcing its stop deadline.
});
