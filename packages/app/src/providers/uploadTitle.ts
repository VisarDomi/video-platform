// Bracketed text containing the recording's `YYYY-MM-DD HHMMSS` timestamp is the
// display label, without brackets. Titles without that timestamp keep their full text.
export function uploadLabel(title: string): string {
    return title.match(/\[([^\]]*\b\d{4}-\d{2}-\d{2}\s+\d{6}\b[^\]]*)\]/)?.[1].trim() || title;
}
