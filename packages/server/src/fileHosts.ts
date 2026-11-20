import express from "express";
import cors from "cors";
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadFileHostPlugin, parseFileHosts } from "sdk";
import { servicesDataRoot, sitesFilePath } from "shared";
import { createFileHostRoutes } from "./api/fileHost.routes.js";
import { createFileHostLibraryFallback, createFileHostLibraryRoutes } from "./api/fileHostLibrary.routes.js";
import { FileHostDownloads } from "./services/fileHostDownloads.js";
import { MP4Library } from "./services/video/mp4Library.js";

// The file hosts of the sites file ("fileHosts"), each a one-at-a-time download queue and
// its local library, on HTTPS :9998. An independently restartable byte-copy service: no
// capture, sign-in, finalizer or upload worker runs here.
const certificates = path.join(os.homedir(), ".local/share/mkcert/pwa");
const port = Number(process.env.VIDEO_FILE_HOSTS_PORT ?? 9998);
const file = sitesFilePath();
const entries = parseFileHosts(readFileSync(file, "utf8"), file);
// A deployment without file hosts has no reason to run this service: say so and stop as
// failed, without systemd restarting it (the unit's RestartPreventExitStatus).
const NOTHING_TO_SERVE = 78;
if (entries.length === 0) {
    console.error(`${file} names no file host ("fileHosts"); nothing to serve`);
    process.exit(NOTHING_TO_SERVE);
}

// "~/..." is the home directory's.
function directoryOf(id: string, config: Readonly<Record<string, unknown>>): string {
    const value = config.directory;
    if (value === undefined) return path.join(os.homedir(), "Videos", id);
    if (typeof value !== "string" || !(value.startsWith("~/") || path.isAbsolute(value))) {
        throw new Error(`${file}: fileHosts ${id}: config.directory must be absolute or start with ~/`);
    }
    return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "4kb" }));
const running: Array<{ queue: FileHostDownloads; library: MP4Library }> = [];
for (const entry of entries) {
    const plugin = await loadFileHostPlugin(entry);
    const host = { id: entry.id, label: plugin.label, fileHost: plugin.createFileHost() };
    const queue = new FileHostDownloads(host, { directory: directoryOf(entry.id, entry.config ?? {}),
        stateDirectory: path.join(servicesDataRoot, `${entry.id}-downloads`) });
    const library = new MP4Library(queue.directory, {
        label: plugin.label,
        stateFile: path.join(servicesDataRoot, `${entry.id}-library`, "index.json"),
        renameHooks: {
            prepare: (from, to, fileId, bytes) => queue.prepareLocalRename(from, to, fileId, bytes),
            commit: (change) => queue.commitLocalRename(change),
        },
    });
    void library.start().catch((error) => console.error(`${plugin.label} library startup:`, error.message));
    app.use(createFileHostRoutes(queue));
    app.use(createFileHostLibraryRoutes(entry.id, plugin.label, library));
    running.push({ queue, library });
}
app.use(createFileHostLibraryFallback(entries.map((entry) => entry.id)));
const server = https.createServer({
    key: readFileSync(path.join(certificates, "key.pem")),
    cert: readFileSync(path.join(certificates, "cert.pem")),
}, app).listen(port, "0.0.0.0", () => console.info(`File host queue (${entries.map((entry) => entry.id).join(", ")}) listening on HTTPS :${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    for (const { queue } of running) queue.stop();
    server.close();
    for (const { library } of running) void library.stop();
    // systemd gives in-flight writes time to flush before enforcing its stop deadline.
});
