// Original containers accepted by both the download queue and its local library.
// This is a filename/media contract, not permission to convert the downloaded bytes.
const contentTypes: Record<string, string> = {
    mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
    webm: "video/webm", avi: "video/x-msvideo", ts: "video/mp2t",
};
export function originalVideoExtension(filename: string): string | undefined {
    const dot = filename.lastIndexOf(".");
    if (dot <= 0) return undefined;
    const extension = filename.slice(dot + 1).toLowerCase();
    return Object.hasOwn(contentTypes, extension) ? extension : undefined;
}
export function originalVideoName(filename: unknown): filename is string {
    return typeof filename === "string" && !filename.startsWith(".") && !/[\x00-\x1f\x7f/\\]/.test(filename)
        && originalVideoExtension(filename) !== undefined;
}
export function originalVideoContentType(filename: string): string {
    return contentTypes[originalVideoExtension(filename) ?? ""] ?? "application/octet-stream";
}
