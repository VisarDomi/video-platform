import * as path from "path";
import winston from "winston";

import * as utils from "./utils.js";

const projectRoot = utils.findProjectRoot()

// Define custom format for console logs
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : "";
        return `${timestamp} ${level}: ${message} ${metaString}`;
    })
);

// Define custom format for file logs
const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.json() // Log in JSON format to the file
);

const logger = winston.createLogger({
    level: "info", // Log 'info' level and above (info, warn, error)
    transports: [
        new winston.transports.Console({
            format: consoleFormat,
        }),
        new winston.transports.File({
            filename: path.join(projectRoot, "error.log"),
            level: "error", // Only log errors to this file
            format: fileFormat,
        }),
    ],
});

export default logger;
