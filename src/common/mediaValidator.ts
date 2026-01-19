import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
interface FFMPEGStream {
    codec_type: string;
    width: number;
    height: number;
}

export class MediaValidator {
    /**
     * Checks if a media segment is corrupted based on bitrate, duration, and specific dimensions.
     * Identifying 0kb/s bitrate, improbable duration, or specific 360x640 resolution artifacts.
     */
    public static async isSegmentCorrupt(filePath: string): Promise<boolean> {
        try {
            // Check bitrate, duration, and streams using JSON output
            // UPDATE: Added -show_streams to access video resolution info
            const cmd = `ffprobe -v error -show_format -show_streams -of json "${filePath}"`;
            const { stdout } = await execAsync(cmd);
            const data = JSON.parse(stdout);

            const duration = parseFloat(data.format.duration);
            const bitRate = parseFloat(data.format.bit_rate);

            // Condition 1: Bitrate is effectively 0 or N/A (NaN)
            // Valid TS files usually have > 100k bitrate.
            if (isNaN(bitRate) || bitRate < 1000) {
                return true;
            }

            // Condition 2: Insane Duration (> 1 hour) for a segment
            // This catches timestamp wrap-around bugs common in some streams.
            if (!isNaN(duration) && duration > 3600) {
                return true;
            }

            // Condition 3: Specific corrupt resolution (Width 360, Height 640)
            // We check the streams array for the video track
            if (data.streams && Array.isArray(data.streams)) {
                const videoStream: FFMPEGStream = data.streams.find((stream: FFMPEGStream) => stream.codec_type === 'video');

                if (videoStream) {
                    const width = videoStream.width;
                    const height = videoStream.height;

                    // If the specific "corrupt" dimension is detected
                    if (width === 360 && height === 640) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error) {
            // If ffprobe fails completely (e.g. corrupt header, unreadable file), treat as corrupt.
            return true;
        }
    }
}