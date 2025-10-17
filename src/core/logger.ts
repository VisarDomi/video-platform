import * as path from "path";
import * as url from "url";
import winston from "winston";

import * as utils from "./utils.js";
import * as constants from "./constants.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname);

const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: constants.LOGS.TIMESTAMP_FORMAT }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, constants.MISC.JSON_INDENT) : constants.MISC.EMPTY_STRING;
        return `${timestamp} ${level}: ${message} ${metaString}`;
    })
);

const fileFormat = winston.format.combine(winston.format.timestamp({ format: constants.LOGS.TIMESTAMP_FORMAT }), winston.format.json());

const logger = winston.createLogger({
    level: constants.LOGS.LEVELS.INFO,
    transports: [
        new winston.transports.Console({
            format: consoleFormat,
        }),
        new winston.transports.File({
            filename: path.join(projectRoot, constants.FILE_NAMES.ERROR_LOG),
            level: constants.LOGS.LEVELS.ERROR,
            format: fileFormat,
        }),
    ],
});

export default logger;
