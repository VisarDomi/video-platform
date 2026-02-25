import { MISC } from "./constants.js";

export function cleanListContent(content: string): string {
    const lines = content.split(MISC.NEW_LINE);
    const uniqueLines = new Set<string>();
    const cleanedLines: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and duplicates
        if (trimmed && !uniqueLines.has(trimmed)) {
            uniqueLines.add(trimmed);
            cleanedLines.push(trimmed);
        }
    }

    // Ensure newline at start and end
    // Logic: [Empty Line] + [Line 1] + [Line 2] ... + [Empty Line]
    if (cleanedLines.length === 0) {
        return MISC.NEW_LINE + MISC.NEW_LINE;
    }

    return MISC.NEW_LINE + cleanedLines.join(MISC.NEW_LINE) + MISC.NEW_LINE;
}