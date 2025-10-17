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
        if (!req.originalUrl.startsWith("/api/") || req.originalUrl === "/api/profiling") {
            return;
        }
        const end = process.hrtime.bigint();
        const duration = Number(end - start) / 1e6; // in milliseconds

        profilingData.unshift({
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            duration: parseFloat(duration.toFixed(3)),
        });

        if (profilingData.length > MAX_PROFILING_ENTRIES) {
            profilingData.pop();
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

    app.get("/profiling", (_req: Request, res: Response) => {
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Backend Profiling</title>
                <style>
                    body { font-family: monospace; background: #111; color: #eee; margin: 0; padding: 1em; }
                    table { border-collapse: collapse; width: 100%; }
                    th, td { border: 1px solid #444; padding: 8px; text-align: left; }
                    th { background: #333; }
                    h1 { text-align: center; }
                    .status-2xx { color: #7f7; }
                    .status-3xx { color: #ff7; }
                    .status-4xx { color: #f77; }
                    .status-5xx { color: #f77; font-weight: bold; }
                    .duration-fast { color: #7f7; }
                    .duration-medium { color: #ff7; }
                    .duration-slow { color: #f77; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>Backend Request Profiling</h1>
                <table id="profilingTable">
                    <thead>
                        <tr>
                            <th>Method</th>
                            <th>Path</th>
                            <th>Status</th>
                            <th>Duration (ms)</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
                <script>
                    function getStatusClass(status) {
                        if (status >= 200 && status < 300) return 'status-2xx';
                        if (status >= 300 && status < 400) return 'status-3xx';
                        if (status >= 400 && status < 500) return 'status-4xx';
                        if (status >= 500) return 'status-5xx';
                        return '';
                    }
                    function getDurationClass(duration) {
                        if (duration < 100) return 'duration-fast';
                        if (duration < 500) return 'duration-medium';
                        return 'duration-slow';
                    }
                    async function fetchData() {
                        try {
                            const response = await fetch('/api/profiling');
                            const data = await response.json();
                            const tableBody = document.querySelector('#profilingTable tbody');
                            tableBody.innerHTML = '';
                            data.forEach(entry => {
                                const row = document.createElement('tr');
                                row.innerHTML = \`
                                    <td>\${entry.method}</td>
                                    <td>\${entry.path}</td>
                                    <td class="\${getStatusClass(entry.status)}">\${entry.status}</td>
                                    <td class="\${getDurationClass(entry.duration)}">\${entry.duration}</td>
                                \`;
                                tableBody.appendChild(row);
                            });
                        } catch (e) {
                            console.error('Failed to fetch profiling data', e);
                        }
                    }
                    fetchData();
                    setInterval(fetchData, 2000);
                </script>
            </body>
            </html>
        `);
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
