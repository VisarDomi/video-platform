import { promises as fs } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "./playlistAuthority.js";

// Tags that describe only the entry that follows them; the rest (a boundary,
// an init map, the header) still apply to the next entry that is kept.
const ENTRY_ONLY_TAG = /^#(EXTINF|EXT-X-PROGRAM-DATE-TIME|EXT-X-BYTERANGE|EXT-X-GAP)\b/;
// Tags that need an entry after them.
const LEADING_TAG = /^#(EXT-X-DISCONTINUITY|EXT-X-MAP)\b/;

// A file whose data never reached the disk is empty or still all zero bytes in
// its first 4 KiB (a TS packet starts with 0x47, an fMP4 box with its non-zero
// size), or cannot be read. A missing file is not judged here.
async function holdsNoMedia(filePath: string): Promise<boolean> {
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

// A power loss leaves NUL bytes in the playlist and entries whose files never
// got their data. Such an entry holds no media and stops players, so it leaves
// the playlist; its file stays on disk. Where media resumes after one, the next
// entry starts after a discontinuity. Returns the names taken out.
export async function dropEntriesWithoutMedia(streamPath: string): Promise<{ dropped: string[]; changed: boolean }> {
    const playlistPath = path.join(streamPath, "playlist.m3u8");
    const original = await fs.readFile(playlistPath, "utf8");
    const lines = original.split(/\r?\n/)
        .filter((line) => !line.includes("\0") || line.replaceAll("\0", "").trim() !== "")
        .map((line) => line.replaceAll("\0", ""));

    const dropped: string[] = [];
    const output: string[] = [];
    let pending: string[] = [];
    let carried: string[] = [];
    let keptBefore = false;
    let gap = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) {
            pending.push(line);
            continue;
        }
        if (await holdsNoMedia(path.join(streamPath, trimmed))) {
            dropped.push(trimmed);
            carried.push(...pending.filter((tag) => !ENTRY_ONLY_TAG.test(tag.trim())));
            pending = [];
            gap ||= keptBefore;
            continue;
        }
        const tags = [...carried, ...pending];
        if (gap && !tags.some((tag) => tag.trim().startsWith("#EXT-X-DISCONTINUITY"))) {
            const first = tags.findIndex((tag) => ENTRY_ONLY_TAG.test(tag.trim()) || LEADING_TAG.test(tag.trim()));
            tags.splice(first < 0 ? tags.length : first, 0, "#EXT-X-DISCONTINUITY");
        }
        output.push(...tags, line);
        carried = [];
        pending = [];
        keptBefore = true;
        gap = false;
    }
    // Nothing follows: a boundary or map left here would introduce no entry.
    output.push(...[...carried, ...pending].filter((tag) => !LEADING_TAG.test(tag.trim())));

    const changed = dropped.length > 0 || original.includes("\0");
    if (changed) await writeFileAtomic(playlistPath, output.join("\n"));
    return { dropped, changed };
}
