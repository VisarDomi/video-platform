export function fixTargetDuration(playlistContent: string): { content: string; wasFixed: boolean } {
    const lines = playlistContent.split("\n");

    let maxExtinf = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#EXTINF:")) {
            const durationStr = trimmed.slice("#EXTINF:".length).replace(",", "");
            const duration = parseFloat(durationStr);
            if (!isNaN(duration) && duration > maxExtinf) {
                maxExtinf = duration;
            }
        }
    }

    if (maxExtinf === 0) {
        return { content: playlistContent, wasFixed: false };
    }

    const requiredTarget = Math.ceil(maxExtinf);

    let currentTarget = 0;
    let targetLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith("#EXT-X-TARGETDURATION:")) {
            currentTarget = parseInt(lines[i].trim().split(":")[1], 10);
            targetLineIndex = i;
            break;
        }
    }

    if (targetLineIndex === -1 || isNaN(currentTarget) || currentTarget >= requiredTarget) {
        return { content: playlistContent, wasFixed: false };
    }

    lines[targetLineIndex] = `#EXT-X-TARGETDURATION:${requiredTarget}`;
    return { content: lines.join("\n"), wasFixed: true };
}
