import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface MediaInfo {
    duration: number;
    bitRate: number;
    width: number;
    height: number;
}

export class MediaValidator {
    /**
     * Probes the media file and returns raw metadata.
     * Returns null if ffprobe fails or output is invalid.
     */
    public static async getMediaInfo(filePath: string): Promise<MediaInfo | null> {
        try {
            // Check bitrate, duration, and streams using JSON output
            const cmd = `ffprobe -v error -show_format -show_streams -of json "${filePath}"`;
            const { stdout } = await execAsync(cmd);
            const data = JSON.parse(stdout);

            const duration = parseFloat(data.format.duration);
            const bitRate = parseFloat(data.format.bit_rate);
            let width = 0;
            let height = 0;

            if (data.streams && Array.isArray(data.streams)) {
                const videoStream = data.streams.find((stream: any) => stream.codec_type === 'video');
                if (videoStream) {
                    width = videoStream.width || 0;
                    height = videoStream.height || 0;
                }
            }

            return {
                duration: isNaN(duration) ? 0 : duration,
                bitRate: isNaN(bitRate) ? 0 : bitRate,
                width,
                height
            };
        } catch (error) {
            // ffprobe failed (corrupt header, unreadable file, etc)
            return null;
        }
    }
}