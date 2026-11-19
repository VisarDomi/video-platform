import type { Logger } from "sdk";
import { taggedLogger } from "shared";
import logger from "./logger.js";

// A site's logger: the core's logger with the site's label as prefix, "[<label>] <message>".
// Monitoring reads these lines, so the prefix and the messages are part of the contract.
// The core logger is looked up on every call, so a test can observe it.
export function siteLogger(label: string): Logger {
    return taggedLogger(logger, label);
}
