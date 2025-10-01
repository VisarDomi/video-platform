// src/downloader/hlsUtils.ts

/**
 * Parses an HLS master playlist to find the best stream URL.
 * Currently, it specifically looks for the 1280x720 resolution stream.
 *
 * @param masterPlaylistBody The string content of the master playlist (.m3u8 file).
 * @returns The relative URL of the best stream, or null if not found.
 */
export function findBestStreamUrl(masterPlaylistBody: string): string | null {
    const lines = masterPlaylistBody.split("\n").filter((line) => line.trim() !== "");
    let relativeLiveUrl: string | null = null;

    for (let i = 0; i < lines.length; i++) {
        // This is the current "happy path" logic we are testing against.
        if (lines[i].includes("RESOLUTION=1280x720")) {
            // The URL is expected to be on the next line.
            if (i + 1 < lines.length) {
                relativeLiveUrl = lines[i + 1].trim(); // Trim whitespace for robustness
                break;
            }
        }
    }

    return relativeLiveUrl;
}
