import { promises as fs } from "fs";
import * as path from "path";
import { parseCompoundSegmentName } from "./segmentIdentity.js";

// Tags that describe the first segment entry rather than the playlist; an
// initialization map before it stays with the header.
const SEGMENT_TAG = /^#(EXTINF|EXT-X-PROGRAM-DATE-TIME|EXT-X-BYTERANGE|EXT-X-DISCONTINUITY|EXT-X-GAP)\b/;

// A file whose data never reached the disk is empty or still all zero bytes
// in its first 4 KiB (a TS packet starts with 0x47, an fMP4 box with its
// non-zero size), or cannot be read. A missing file is not judged here.
export async function lacksMedia(filePath: string): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
        handle = await fs.open(filePath, "r");
    } catch {
        return false;
    }
    try {
        const head = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        return head.subarray(0, bytesRead).every((byte) => byte === 0);
    } catch {
        return true;
    } finally {
        await handle.close();
    }
}

// After a power loss the playlist can end in NUL bytes or a torn line, and its
// last entries can name files whose data never reached the disk. Those entries
// carry no media and only stop players, so the playlist is cut after the last
// segment entry whose file has bytes; the files stay on disk.
export async function recoverPlaylistTail(
    dirPath: string,
    content: string,
    recordingId?: string,
): Promise<{ content: string; dropped: string[] }> {
    const sanitized = content.replaceAll("\0", "");
    const lines = sanitized.split(/\r?\n/);
    const entries = lines
        .map((line, index) => ({ name: line.trim(), index, identity: parseCompoundSegmentName(line.trim()) }))
        .filter((entry) => entry.identity !== null
            && (recordingId === undefined || entry.identity.recordingId === recordingId));
    if (entries.length === 0) return { content: sanitized, dropped: [] };
    const keep = (count: number) => lines.slice(0, count).join("\n").replace(/\n*$/, "\n");
    const dropped: string[] = [];
    for (let at = entries.length - 1; at >= 0; at--) {
        if (!await lacksMedia(path.join(dirPath, entries[at].name))) {
            return { content: keep(entries[at].index + 1), dropped };
        }
        dropped.unshift(entries[at].name);
    }
    // No entry kept any media: only the header remains.
    let headerEnd = entries[0].index;
    while (headerEnd > 0 && SEGMENT_TAG.test(lines[headerEnd - 1].trim())) headerEnd--;
    return { content: keep(headerEnd), dropped };
}

export function describeDropped(dropped: readonly string[]): string {
    if (dropped.length === 0) return "";
    const range = dropped.length === 1 ? dropped[0] : `${dropped[0]} … ${dropped.at(-1)}`;
    return `; dropped ${dropped.length} tail entr${dropped.length === 1 ? "y" : "ies"} whose media never reached the disk (files kept): ${range}`;
}
