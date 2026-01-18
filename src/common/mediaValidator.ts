import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class MediaValidator {
    /**
     * Checks if a media segment is corrupted based on bitrate and duration.
     * Identifying 0kb/s bitrate or improbable duration (> 1 hour) for short segments.
     */
    public static async isSegmentCorrupt(filePath: string): Promise<boolean> {
        try {
            // Check bitrate and duration using JSON output for reliability
            // -show_format gives us container level info (duration, bit_rate)
            const cmd = `ffprobe -v error -show_format -of json "${filePath}"`;
            const { stdout } = await execAsync(cmd);
            const data = JSON.parse(stdout);

            const duration = parseFloat(data.format.duration);
            const bitRate = parseFloat(data.format.bit_rate);

            // Condition 1: Bitrate is effectively 0 or N/A (NaN)
            // Valid TS files usually have > 100k bitrate.
            // We use a safe threshold of 1000 bps (1 kbps) to catch empty/header-only files.
            if (isNaN(bitRate) || bitRate < 1000) {
                return true;
            }

            // Condition 2: Insane Duration (> 1 hour) for a segment
            // This catches timestamp wrap-around bugs common in some streams.
            if (!isNaN(duration) && duration > 3600) {
                return true;
            }

            return false;
        } catch (error) {
            // If ffprobe fails completely (e.g. corrupt header, unreadable file), treat as corrupt.
            return true;
        }
    }
}