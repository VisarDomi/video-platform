// SC keeps its provider MP4 fragments under legacy .ts filenames. HLS clients
// must receive the container type of the bytes, rather than the saved suffix.
export function hlsSegmentContentType(data: Buffer, name: string): string {
    for (let offset = 0, count = 0; offset + 8 <= data.length && count < 16; count++) {
        let size = data.readUInt32BE(offset), header = 8;
        if (size === 1) {
            if (offset + 16 > data.length) break;
            size = Number(data.readBigUInt64BE(offset + 8)); header = 16;
        } else if (size === 0) size = data.length - offset;
        if (!Number.isSafeInteger(size) || size < header || offset + size > data.length) break;
        if (["ftyp", "styp", "sidx", "moof"].includes(data.toString("ascii", offset + 4, offset + 8))) {
            return "video/mp4";
        }
        offset += size;
    }
    return name.endsWith(".mp4") ? "video/mp4" : "video/mp2t";
}
