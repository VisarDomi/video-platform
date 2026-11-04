export interface PlaybackRendition { width: number; height: number; label: string | null }

export function parsePlaybackRenditions(manifest: string): PlaybackRendition[] {
    if (!manifest.trimStart().startsWith("#EXTM3U")) return [];
    return manifest.split(/\r?\n/).filter((line) => line.startsWith("#EXT-X-STREAM-INF:"))
        .flatMap((line) => {
            const dimensions = line.match(/\bRESOLUTION=(\d+)x(\d+)/);
            if (!dimensions) return [];
            const width = Number(dimensions[1]), height = Number(dimensions[2]);
            if (!Number.isSafeInteger(width * height) || width <= 0 || height <= 0) return [];
            return [{ width, height, label: line.match(/\bNAME="([^"]+)"/)?.[1] ?? null }];
        });
}

// A provider's 1080p version is at least 1080 on its short side (1920x1080,
// or 1440x1080 for a 4:3 upload); labels count for nothing.
export function hasFullHdPlayback(renditions: readonly PlaybackRendition[]): boolean {
    // Provider even-dimension rounding can undershoot its nominal tier
    // slightly. This tolerance is far below the gap between 720p and 1080p.
    return renditions.some(({ width, height }) => Math.min(width, height) >= 1080 * 0.995);
}

// The player's qualities: video_url, video_alt_url, video_alt_url2… each with a
// `<key>_text` label ("720p HD", "1080p FHD"). Porntrex scales by height, so a
// portrait "720p" is 406x720; only the probe says what a tier really holds.
export function playerTiers(html: string): Array<{ label: string; url: string }> {
    const fields = new Map([...html.matchAll(/\b(video_(?:alt_)?url\d*(?:_text)?)\s*:\s*'([^']*)'/g)].map((match) => [match[1], match[2]]));
    return [...fields].filter(([key, value]) => !key.endsWith("_text") && value.includes("/get_file/"))
        .map(([key, url]) => ({ label: fields.get(`${key}_text`) ?? "", url }))
        .sort((left, right) => Number(right.label.match(/(\d{3,4})p/)?.[1] ?? 0) - Number(left.label.match(/(\d{3,4})p/)?.[1] ?? 0));
}
