export interface XvideosEntry {
    readonly remoteId: string;
    readonly remoteUrl: string;
    readonly title: string;
    readonly moderationStatus: string | null;
}

export interface XvideosEntryCandidate {
    readonly containerId: string;
    readonly remoteUrl: string;
    readonly title: string;
    readonly text: string;
}

export function parseXvideosEntry(candidate: XvideosEntryCandidate): XvideosEntry | null {
    const idMatch = candidate.containerId.match(/^listing-video-(\d+)$/);
    if (!idMatch || !candidate.remoteUrl || !candidate.title.trim()) return null;
    const status = candidate.text.match(/Status:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
    return {
        remoteId: idMatch[1],
        remoteUrl: candidate.remoteUrl,
        title: candidate.title.trim(),
        moderationStatus: status,
    };
}

export function findXvideosEntry(
    candidates: readonly XvideosEntryCandidate[],
    matchKey: string,
): XvideosEntry | null {
    if (!matchKey.trim()) throw new Error("A nonempty upload match key is required");
    const matches = candidates.map(parseXvideosEntry)
        .filter((entry): entry is XvideosEntry => entry !== null && entry.title.includes(matchKey));
    if (matches.length > 1) throw new Error(`Multiple XVideos entries match ${matchKey}`);
    return matches[0] ?? null;
}
