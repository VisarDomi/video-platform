// What a destination changed in the text it was sent: the one changed span, and the
// words it silently replaced (filtered words are learned as phrases to avoid).

export function changedText(expected: string, stored: string): { from: string; to: string } {
    const left = expected.split(/(\s+)/);
    const right = stored.split(/(\s+)/);
    let start = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start++;
    let end = 0;
    while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
    return { from: left.slice(start, left.length - end).join("").trim(), to: right.slice(start, right.length - end).join("").trim() };
}

// Words a destination silently replaced in our text (one word swapped for another), to
// learn as phrases to avoid. Only word-for-word alignments or one short changed
// span count, so a reworded or truncated text never teaches anything.
export function swappedWords(expected: string, stored: string): string[] {
    const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);
    const clean = (word: string) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const left = words(expected);
    const right = words(stored);
    let learned: string[];
    if (left.length === right.length) {
        learned = left.filter((word, index) => clean(word) !== clean(right[index])).map(clean);
        if (learned.length > 3) return [];
    } else {
        const from = words(changedText(expected, stored).from);
        learned = from.length <= 2 ? from.map(clean) : [];
    }
    return [...new Set(learned.filter((word) => word.length >= 3))];
}
