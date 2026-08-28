import type { UpscaleMode } from "../stages/upscale.js";

export interface RemuxOneArguments {
    readonly recordingPath: string;
    readonly upscaleMode: UpscaleMode | null;
}

export function parseRemuxOneArguments(args: readonly string[]): RemuxOneArguments {
    let recordingPath: string | null = null;
    let upscaleMode: UpscaleMode | null = null;
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === "--recording") {
            const value = args[++index];
            if (recordingPath !== null || !value || value.startsWith("--")) {
                throw new Error("remux-one requires exactly one nonempty --recording PATH");
            }
            recordingPath = value;
            continue;
        }
        const requestedMode = argument === "--upscale1080p"
            ? "upscale1080p"
            : argument === "--upscale1440p" ? "upscale1440p" : null;
        if (requestedMode !== null) {
            if (upscaleMode !== null) throw new Error("remux-one accepts at most one upscale flag");
            upscaleMode = requestedMode;
            continue;
        }
        throw new Error(`Unknown remux-one option: ${argument}`);
    }
    if (recordingPath === null) throw new Error("remux-one requires exactly one nonempty --recording PATH");
    return { recordingPath, upscaleMode };
}
