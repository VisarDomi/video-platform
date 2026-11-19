#!/usr/bin/env node
// simulator prep  --input <dir> --out <cacheDir> [--minutes N] [--max-height H]
// simulator serve --scenario <file> --media <cacheDir> [--state <dir>] [--tls-cert F --tls-key F]
//                 [--host 127.0.0.1] [--ports ts-live=18081,ladder-live=18082,fmp4-live=18083,control=18080]
//                 [--clock real|manual]
import { prepAll } from "./media/prep.js";

export function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
    const [command = "help", ...rest] = argv;
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (!arg.startsWith("--")) throw new Error(`unexpected argument "${arg}"`);
        const eq = arg.indexOf("=");
        if (eq > 0) { flags.set(arg.slice(2, eq), arg.slice(eq + 1)); continue; }
        const next = rest[i + 1];
        if (next === undefined || next.startsWith("--")) flags.set(arg.slice(2), "true");
        else { flags.set(arg.slice(2), next); i++; }
    }
    return { command, flags };
}

function required(flags: Map<string, string>, name: string): string {
    const value = flags.get(name);
    if (!value || value === "true") throw new Error(`--${name} is required`);
    return value;
}

const USAGE = `usage:
  simulator prep  --input <dir> --out <cacheDir> [--minutes N] [--max-height 1080]
  simulator serve --scenario <file> --media <cacheDir> [--state <dir>] [--host 127.0.0.1]
                  [--ports ts-live=18081,ladder-live=18082,fmp4-live=18083,control=18080]
                  [--tls-cert <file> --tls-key <file>] [--clock real|manual]`;

async function main(): Promise<void> {
    const { command, flags } = parseArgs(process.argv.slice(2));
    if (command === "prep") {
        const minutes = flags.get("minutes");
        const manifests = await prepAll({
            input: required(flags, "input"),
            out: required(flags, "out"),
            minutes: minutes ? Number(minutes) : null,
            maxHeight: flags.has("max-height") ? Number(flags.get("max-height")) : undefined,
            log: message => process.stderr.write(message + "\n"),
        });
        for (const m of manifests) {
            const ts = m.renditions["ts"];
            process.stdout.write(`${m.id}: ${ts.segments.length} TS segments, ${ts.loopDurationS.toFixed(1)} s, ${ts.width}x${ts.height}\n`);
        }
        return;
    }
    if (command === "serve") {
        const { serveFromCli } = await import("./serve.js");
        await serveFromCli(flags);
        return;
    }
    process.stdout.write(USAGE + "\n");
    if (command !== "help" && command !== "--help") process.exitCode = 2;
}

main().catch(error => {
    process.stderr.write(`simulator: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
