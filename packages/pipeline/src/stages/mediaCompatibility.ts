import { spawn } from "node:child_process";
import type { NativeStreamLayout } from "./resolutionPolicy.js";

export interface NativeInputRun {
    readonly path: string;
    readonly durationSeconds: number;
    readonly layout: readonly NativeStreamLayout[];
}

export class RemuxCompatibilityError extends Error {}

export async function probeNativeStreamLayout(input: string): Promise<NativeStreamLayout[]> {
    return await new Promise((resolve, reject) => {
        const child = spawn("ffprobe", ["-v", "error", "-show_entries",
            "stream=codec_type,codec_name,time_base,pix_fmt,sample_rate,channels,channel_layout,start_time,width,height,profile",
            "-of", "json", input], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "", error = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { error = `${error}${chunk}`.slice(-16384); });
        child.once("error", reject);
        child.once("close", code => {
            if (code !== 0) return reject(new Error(`Native stream probe failed (${code}): ${error}`));
            try {
                const streams = (JSON.parse(output).streams ?? []).filter((stream: NativeStreamLayout) =>
                    ["video", "audio"].includes(stream.codec_type));
                if (!streams.some((stream: NativeStreamLayout) => stream.codec_type === "video")) {
                    throw new Error(`Native input has no video: ${input}`);
                }
                resolve(streams);
            } catch (error) { reject(error); }
        });
    });
}

export function nativeStreamCompatibility(layouts: readonly (readonly NativeStreamLayout[])[]): string | null {
    const signature = (streams: readonly NativeStreamLayout[]) => JSON.stringify(streams.map(stream => ({
        type: stream.codec_type, codec: stream.codec_name, timeBase: stream.time_base,
        pixelFormat: stream.pix_fmt, sampleRate: stream.sample_rate,
        channels: stream.channels, channelLayout: stream.channel_layout,
        audioProfile: stream.codec_type === "audio" ? stream.profile : undefined,
        // H264 parameter-set changes have real native-remux fidelity tests;
        // do not assume equivalent support in other codecs.
        geometry: stream.codec_type === "video" && stream.codec_name !== "h264"
            ? [stream.width, stream.height] : undefined,
    })));
    if (!layouts.length || layouts.some(layout => !layout.some(stream => stream.codec_type === "video"))) {
        return "input has no established video stream";
    }
    if (layouts.some(layout => layout.filter(stream => stream.codec_type === "video").length !== 1
        || layout.filter(stream => stream.codec_type === "audio").length > 1)) {
        return "multiple video/audio tracks require an explicit track-selection policy";
    }
    return layouts.every(layout => signature(layout) === signature(layouts[0])) ? null
        : "native codec, pixel format, track layout, audio format or time base changes";
}
