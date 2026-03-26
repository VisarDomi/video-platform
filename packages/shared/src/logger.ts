import winston from "winston";

const TIMESTAMP_FORMAT = "YYYY-MM-DD HH:mm:ss";
const JSON_INDENT = 0;

export function createLogger(service: string): winston.Logger {
    return winston.createLogger({
        level: "info",
        transports: [
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.timestamp({ format: TIMESTAMP_FORMAT }),
                    winston.format.printf(({ timestamp, level, message, ...meta }) => {
                        const metaString = Object.keys(meta).length
                            ? " " + JSON.stringify(meta, null, JSON_INDENT)
                            : "";
                        return `${timestamp} [${service}] ${level}: ${message}${metaString}`;
                    }),
                ),
            }),
        ],
    });
}
