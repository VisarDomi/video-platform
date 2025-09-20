// logger.ts
import { getConfig } from './config.js';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';

// Get base directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = path.resolve(__dirname, '..'); // Place logs in the root folder

// Define custom format for console logs
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} ${level}: ${message} ${metaString}`;
    })
);

// Define custom format for file logs
const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.json() // Log in JSON format to the file
);

const logger = winston.createLogger({
    level: 'info', // Log 'info' level and above (info, warn, error)
    transports: [
        // 1. A transport to log to the CONSOLE
        new winston.transports.Console({
            format: consoleFormat,
        }),
        // 2. A transport to log ERRORS to a file
        new winston.transports.File({
            filename: path.join(logDir, getConfig().fileNames.errorLog),
            level: 'error', // Only log errors to this file
            format: fileFormat,
        }),
    ],
});

export default logger;
