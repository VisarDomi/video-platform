import type { Readable } from "node:stream";

// The runner protocol: JSON lines between the PC (which holds the ledger) and the runner
// on the uplink's machine, over the runner command's stdin and stdout (an ssh session in
// production). The runner speaks first (hello), then answers one command:
//
//   upload   the PC sends the request, the session and where the file is; the runner sends
//            progress, evidence and session lines, each waiting for the PC's ack (the PC
//            records it durably first), then one result or error line.
//   probe    the runner answers with the network it is on, the carrier.
//   release  the runner unmounts the carrier when nothing is left to send.
//
// The PC pings every ten seconds; a runner that hears nothing for a minute, or whose stdin
// closes, stops its upload. Nothing secret is ever written to stderr, arguments or files
// outside the runner's private temporary folder.
export const UPLINK_PROTOCOL = 1;
export const PING_INTERVAL_MS = 10_000;
export const PING_TIMEOUT_MS = 60_000;
// The runner checks its network at most this far apart while it transfers.
export const NETWORK_RECHECK_MS = 30_000;

export interface CarrierLocation {
    // The carrier's root on the runner's machine, and the ID its carrier.json must name.
    readonly root: string;
    readonly id: string;
}

export interface NetworkExpectation {
    readonly gateway: string;
    readonly probe?: readonly string[];
}

// The carrier's marker file and the folder its files are in.
export const CARRIER_MARKER = "carrier.json";
export const CARRIER_FILES = "files";

// Calls onLine for each complete line; the last line without a newline is dropped
// (a writer that died mid-line said nothing).
export function readLines(stream: Readable, onLine: (line: string) => void, onEnd: () => void): void {
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
        buffered += chunk;
        for (;;) {
            const newline = buffered.indexOf("\n");
            if (newline < 0) break;
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (line) onLine(line);
        }
        if (buffered.length > 64 * 1024 * 1024) throw new Error("uplink: a protocol line exceeded 64 MiB");
    });
    stream.on("end", onEnd);
    stream.on("close", onEnd);
}

export function parseMessage(line: string): Record<string, unknown> & { type: string } {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("uplink: a protocol line is not JSON"); }
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
        throw new Error("uplink: a protocol line has no type");
    }
    return value as Record<string, unknown> & { type: string };
}
