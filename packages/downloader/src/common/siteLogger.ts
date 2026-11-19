import type { Logger } from "sdk";
import logger from "./logger.js";

// A site's logger: the core's logger with the site's label as prefix, "[<label>] <message>".
// Monitoring reads these lines, so the prefix and the messages are part of the contract.
// The core logger is looked up on every call, so a test can observe it.
export function siteLogger(label: string): Logger {
    const prefix = `[${label}] `;
    const line = (level: "debug" | "verbose" | "info" | "warn" | "error") =>
        (message: string, meta?: Record<string, unknown>) => {
            if (meta === undefined) logger[level](prefix + message);
            else logger[level](prefix + message, meta);
        };
    return { debug: line("debug"), verbose: line("verbose"), info: line("info"), warn: line("warn"), error: line("error") };
}
