import * as path from "path";
import * as url from "url";
import winston from "winston";

import * as utils from "./utils.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname);

const scDebugFilter = winston.format((info) => {
    if (!process.env.SC_DEBUG) return info;
    if (info.level?.includes("error")) return info;
    if (typeof info.message === "string" && info.message.includes("[StreamDownloader]")) return info;
    return false;
})();

const consoleFormat = winston.format.combine(
    scDebugFilter,
    winston.format.colorize(),
    winston.format.timestamp({ format: "HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaString = Object.keys(meta).length ? JSON.stringify(meta) : "";
        return `${timestamp} ${level}: ${message} ${metaString}`;
    })
);

const fileFormat = winston.format.combine(winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), winston.format.json());

const logger = winston.createLogger({
    level: "info",
    transports: [
        new winston.transports.Console({
            format: consoleFormat,
        }),
        new winston.transports.File({
            filename: path.join(projectRoot, "error.log"),
            level: "error",
            format: fileFormat,
        }),
    ],
});

export default logger;