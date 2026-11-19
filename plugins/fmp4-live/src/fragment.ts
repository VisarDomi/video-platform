// A media fragment's duration from its segment index (sidx), in seconds; null when the
// fragment has none. Each sidx is one track's index; the longest track counts.
export function fragmentDurationS(data: Buffer): number | null {
    let longest = 0;
    for (let at = 0; at + 8 <= data.length;) {
        const size = data.readUInt32BE(at);
        if (size < 8 || at + size > data.length) break;
        if (data.toString("latin1", at + 4, at + 8) === "sidx") {
            const version = data[at + 8];
            const timescale = data.readUInt32BE(at + 16);
            // reference_ID, timescale, then the earliest time and first offset: 32-bit
            // each in version 0, 64-bit each in version 1; then reserved and the count.
            const countAt = at + 20 + (version === 0 ? 8 : 16) + 2;
            if (timescale > 0 && countAt + 2 <= at + size) {
                const count = data.readUInt16BE(countAt);
                let ticks = 0;
                for (let i = 0, ref = countAt + 2; i < count && ref + 12 <= at + size; i++, ref += 12) ticks += data.readUInt32BE(ref + 4);
                longest = Math.max(longest, ticks / timescale);
            }
        }
        at += size;
    }
    return longest > 0 ? Math.round(longest * 1000) / 1000 : null;
}
