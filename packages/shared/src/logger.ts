import { fstatSync } from "fs";
import winston from "winston";

const TIMESTAMP_FORMAT = "YYYY-MM-DD HH:mm:ss";
const JSON_INDENT = 0;
const REPEAT_WINDOW_MS = 60_000;
// sd-daemon(3): journald reads a leading <N> as the line's priority, so
// `journalctl -p warning` shows only warnings and errors.
const JOURNAL_PRIORITY: Record<string, number> = { error: 3, warn: 4, info: 6, debug: 7 };
// Marks a repeat summary; a symbol survives the transport's copy of the line and
// never reaches the output.
const SUMMARY = Symbol("repeat-summary");

interface Repeat {
    readonly info: winston.Logform.TransformableInfo;
    count: number;
}

// True when the descriptor is the journald stream systemd connected (JOURNAL_STREAM
// names it); a child process inheriting the variable with redirected output is not.
function writesToJournal(fd: 1 | 2 = 1): boolean {
    const [device, inode] = (process.env.JOURNAL_STREAM ?? "").split(":");
    if (!device || !inode) return false;
    try {
        const stat = fstatSync(fd);
        return String(stat.dev) === device && String(stat.ino) === inode;
    } catch {
        return false;
    }
}

// The priority prefix for a line written straight to stdout (1) or stderr (2), or ""
// when that stream is not the journal. For services that print their own lines.
export function journalPriority(level: "error" | "warn" | "info" | "debug", fd: 1 | 2 = 1): string {
    return writesToJournal(fd) ? `<${JOURNAL_PRIORITY[level]}>` : "";
}

// Under journald a line has no colour codes or timestamp (journald stamps it) and
// starts with its priority. LOG_LEVEL (default info) selects the detail; debug
// adds the routine per-poll and per-retry lines.
//
// An identical line (same level, message and details) repeated within a minute is
// dropped; once the minute is over one line reports how often, as syslog's
// "last message repeated". A loop can therefore never flood the journal.
export function createLogger(service: string): winston.Logger {
    const journal = writesToJournal();
    const repeats = new Map<string, Repeat>();

    const collapseRepeats = winston.format((info) => {
        if ((info as Record<symbol, unknown>)[SUMMARY]) return info;
        const { level, message, ...details } = info;
        let key: string;
        try {
            key = `${level}\u0000${String(message)}\u0000${JSON.stringify(details)}`;
        } catch {
            return info;
        }
        const repeat = repeats.get(key);
        if (repeat) {
            repeat.count++;
            return false;
        }
        repeats.set(key, { info: { ...info }, count: 0 });
        return info;
    });

    const line = winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaString = Object.keys(meta).length
            ? " " + JSON.stringify(meta, null, JSON_INDENT)
            : "";
        const prefix = journal ? `<${JOURNAL_PRIORITY[level] ?? 6}>` : `${timestamp} `;
        return `${prefix}[${service}] ${level}: ${message}${metaString}`;
    });

    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL ?? "info",
        transports: [
            new winston.transports.Console({
                format: journal
                    ? winston.format.combine(collapseRepeats(), line)
                    : winston.format.combine(
                        collapseRepeats(),
                        winston.format.colorize(),
                        winston.format.timestamp({ format: TIMESTAMP_FORMAT }),
                        line,
                    ),
            }),
        ],
    });

    setInterval(() => {
        const ended = [...repeats.values()];
        repeats.clear();
        for (const { info, count } of ended) {
            if (count === 0) continue;
            const { level, message, ...details } = info;
            logger.log({
                ...details,
                level,
                message: `${String(message)} (repeated ${count} more time${count === 1 ? "" : "s"} within a minute)`,
                [SUMMARY]: true,
            });
        }
    }, REPEAT_WINDOW_MS).unref();

    return logger;
}
