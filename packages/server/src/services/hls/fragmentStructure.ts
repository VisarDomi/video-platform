import { promises as fs } from "node:fs";

// FFmpeg can silently skip an empty/garbage fragment in an otherwise good
// playlist. Verify top-level boxes without reading payloads or spawning probes.
export async function inspectFmp4Fragment(inputPath: string): Promise<string | null> {
    let handle;
    try {
        handle = await fs.open(inputPath, "r");
        const stats = await handle.stat();
        let offset = 0, moof = false, payload = false, boxCount = 0;
        const header = Buffer.alloc(16);
        while (offset < stats.size && boxCount++ < 128) {
            const { bytesRead } = await handle.read(header, 0, 16, offset);
            if (bytesRead < 8) return "invalid fMP4 fragment structure: truncated box header";
            let size = header.readUInt32BE(0), headerSize = 8;
            if (size === 1) {
                if (bytesRead < 16) return "invalid fMP4 fragment structure: truncated extended size";
                size = Number(header.readBigUInt64BE(8)); headerSize = 16;
            }
            if (size === 0) size = stats.size - offset;
            if (!Number.isSafeInteger(size) || size < headerSize || offset + size > stats.size) {
                return "invalid fMP4 fragment structure: box exceeds saved file";
            }
            const type = header.toString("ascii", 4, 8);
            if (type === "moof" && size > headerSize) moof = true;
            if (type === "mdat" && size > headerSize) payload = true;
            offset += size;
        }
        return offset === stats.size && moof && payload ? null
            : "invalid fMP4 fragment structure: missing moof/media payload";
    } catch (error: any) {
        if (error?.code === "ENOENT") return "invalid fMP4 fragment structure: missing saved fragment";
        throw error; // access/I/O failures must not authorize media deletion
    } finally { await handle?.close(); }
}
