export interface XvideosEntry {
    readonly remoteId: string;
    readonly remoteUrl: string;
    readonly title: string;
}

export interface XvideosEntryCandidate {
    readonly containerId: string;
    readonly remoteUrl: string;
    readonly title: string;
}

export function parseXvideosEntry(candidate: XvideosEntryCandidate): XvideosEntry | null {
    const idMatch = candidate.containerId.match(/^listing-video-(\d+)$/);
    if (!idMatch || !candidate.remoteUrl || !candidate.title.trim()) return null;
    return {
        remoteId: idMatch[1],
        remoteUrl: candidate.remoteUrl,
        title: candidate.title.trim(),
    };
}

export function filterXvideosEntries(
    candidates: readonly XvideosEntryCandidate[],
    searchTerm: string,
): XvideosEntry[] {
    const term = searchTerm.trim().toLowerCase();
    return candidates.map(parseXvideosEntry)
        .filter((entry): entry is XvideosEntry => entry !== null && entry.title.toLowerCase().includes(term));
}
