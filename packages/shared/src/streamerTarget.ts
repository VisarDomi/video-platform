// The site-agnostic part of a recording's identity. Everything about one site's lists
// and pages (line formats, page URLs) lives in that site's catalog, reached through the
// sites registry.

// The identifier a recording folder was named with: everything after the folder's date
// and time ("2026-03-04 050607 <identifier>").
export function extractRecordingIdentifier(filename: string): string {
    const parts = filename.trim().split(/\s+/);
    return parts.length >= 3 ? parts.slice(2).join(" ") : filename.trim();
}
