// src/downloader/hlsUtils.ts

interface StreamInfo {
    url: string;
    bandwidth: number;
    resolution?: string;
}

/**
 * Parses the attribute string from an #EXT-X-STREAM-INF tag.
 * Example: `BANDWIDTH=2337000,RESOLUTION=1280x720`
 * @param attributesString The string of attributes.
 * @returns An object with parsed attributes.
 */
function parseAttributes(attributesString: string): Omit<StreamInfo, 'url'> {
    const attributes: { [key: string]: string } = {};
    // This regex handles attributes that might contain commas inside quotes,
    // though for this specific use case, a simple split would also work.
    attributesString.match(/([A-Z-]+)="?([^",]+)"?/g)?.forEach((attr) => {
        const [key, value] = attr.split('=', 2);
        if (key && value) {
            attributes[key] = value;
        }
    });

    return {
        bandwidth: parseInt(attributes.BANDWIDTH || '0', 10),
        resolution: attributes.RESOLUTION,
    };
}

/**
 * Parses an HLS master playlist to find the best quality stream URL,
 * determined by the highest bandwidth.
 *
 * @param masterPlaylistBody The string content of the master playlist (.m3u8 file).
 * @returns The relative URL of the highest bandwidth stream, or null if not found.
 */
export function findBestStreamUrl(masterPlaylistBody: string): string | null {
    const lines = masterPlaylistBody.split("\n").filter((line) => line.trim() !== "");
    const availableStreams: StreamInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("#EXT-X-STREAM-INF:")) {
            const attributesString = line.substring("#EXT-X-STREAM-INF:".length);
            const parsedAttributes = parseAttributes(attributesString);

            // The stream URL is expected on the next non-empty line
            if (i + 1 < lines.length && !lines[i + 1].startsWith("#")) {
                const url = lines[i + 1].trim();
                availableStreams.push({
                    url,
                    ...parsedAttributes,
                });
            }
        }
    }

    if (availableStreams.length === 0) {
        return null;
    }

    // Sort streams by bandwidth in descending order to find the best one
    availableStreams.sort((a, b) => b.bandwidth - a.bandwidth);

    // The best stream is the first one in the sorted array
    return availableStreams[0].url;
}
