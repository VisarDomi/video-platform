#!/usr/bin/env node
// simulator prep  --input <dir> --out <cacheDir> [--minutes N] [--max-height H]
// simulator serve --scenario <file> --media <cacheDir> [--state <dir>] [--tls-cert F --tls-key F]
//                 [--host 127.0.0.1] [--ports name=port,...] [--clock real|manual]
//                 [--truth-max-bytes 100M] [--truth-max-age 1h] [--truth-keep N]
// simulator check --truth <file|dir> --recording <dir> --site <id> --channel <id>
//                 [--media <cacheDir>] [--whole-session | --from T --to T] [--json <file>]
import { writeFileSync } from "node:fs";
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
                  [--ports control=18080,ts-live=18081,ladder-live=18082,fmp4-live=18083,
                           file-host=18084,form-host=18085,api-host=18086,file-host-cdn=18087]
                  [--tls-cert <file> --tls-key <file>] [--clock real|manual]
                  [--truth-max-bytes 100M] [--truth-max-age 1h] [--truth-keep N]
  simulator check --truth <file|dir> --recording <dir> --site <id> --channel <id>
                  [--media <cacheDir>] [--whole-session | --from <time> --to <time>] [--json <file>]
                  JSON on stdout (or --json), a summary on stderr; exit 0 = OK, 1 = problems found`;

function instant(value: string, name: string): number {
    const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error(`--${name}: expected an ISO time or epoch milliseconds`);
    return ms;
}

async function check(flags: Map<string, string>): Promise<void> {
    const { TruthIndex } = await import("./truth/query.js");
    const { checkRecording, formatReport } = await import("./check/checker.js");
    const { MediaLibrary } = await import("./media/library.js");
    const from = flags.get("from"), to = flags.get("to");
    if (Boolean(from) !== Boolean(to)) throw new Error("--from and --to go together");
    const report = checkRecording(TruthIndex.fromFile(required(flags, "truth")), required(flags, "recording"), {
        site: required(flags, "site"), channel: required(flags, "channel"),
        media: flags.has("media") ? MediaLibrary.load(required(flags, "media")) : undefined,
        expect: from && to ? { mode: "window", from: instant(from, "from"), to: instant(to, "to") }
            : flags.has("whole-session") ? { mode: "whole-session" } : { mode: "recorded-span" },
    });
    const json = JSON.stringify(report, null, 2) + "\n";
    const out = flags.get("json");
    if (out) {
        writeFileSync(out, json);
        process.stdout.write(formatReport(report) + "\n");
    } else {
        process.stdout.write(json);
        process.stderr.write(formatReport(report) + "\n");
    }
    process.exitCode = report.ok ? 0 : 1;
}

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
    if (command === "check") {
        await check(flags);
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
    // check: 1 means "problems found", so a run that could not check says 2.
    process.exitCode = process.argv[2] === "check" ? 2 : 1;
});
