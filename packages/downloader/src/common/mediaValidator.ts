import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface MediaInfo {
    duration: number;
    formatDuration: number;
    videoDuration: number;
    audioDuration: number;
    bitRate: number;
    width: number;
    height: number;
}

export class MediaValidator {
    public static async getMediaInfo(filePath: string): Promise<MediaInfo | null> {
        try {
            const cmd = `ffprobe -v error -show_format -show_streams -of json "${filePath}"`;
            const { stdout } = await execAsync(cmd);
            const data = JSON.parse(stdout);

            const formatDuration = parseFloat(data.format.duration);
            const bitRate = parseFloat(data.format.bit_rate);
            let width = 0;
            let height = 0;
            let videoDuration = NaN;
            let audioDuration = NaN;

            if (data.streams && Array.isArray(data.streams)) {
                const videoStream = data.streams.find((stream: any) => stream.codec_type === 'video');
                if (videoStream) {
                    width = videoStream.width || 0;
                    height = videoStream.height || 0;
                    videoDuration = parseFloat(videoStream.duration);
                }

                const audioStream = data.streams.find((stream: any) => stream.codec_type === 'audio');
                if (audioStream) {
                    audioDuration = parseFloat(audioStream.duration);
                }
            }

            const mediaDurations = [videoDuration, audioDuration]
                .filter((value) => !isNaN(value) && value > 0);
            const duration = mediaDurations.length > 0
                ? Math.max(...mediaDurations)
                : (!isNaN(formatDuration) && formatDuration > 0 ? formatDuration : 0);

            return {
                duration,
                formatDuration: isNaN(formatDuration) ? 0 : formatDuration,
                videoDuration: isNaN(videoDuration) ? 0 : videoDuration,
                audioDuration: isNaN(audioDuration) ? 0 : audioDuration,
                bitRate: isNaN(bitRate) ? 0 : bitRate,
                width,
                height
            };
        } catch (error) {
            return null;
        }
    }
}
