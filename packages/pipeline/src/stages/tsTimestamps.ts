import { promises as fs } from "node:fs";

const TS_PACKET_BYTES = 188;
const READ_BYTES = TS_PACKET_BYTES * 64;
const PTS_WRAP = 2 ** 33;
const PTS_HZ = 90_000;

function videoPesPts(buffer: Buffer, start: number): number | null {
    if (buffer[start] !== 0x47 || (buffer[start + 1] & 0x40) === 0) return null;
    const adaptation = (buffer[start + 3] >> 4) & 0x03;
    if (adaptation === 0 || adaptation === 2) return null;
    const payload = start + 4 + (adaptation === 3 ? 1 + buffer[start + 4] : 0);
    if (payload + 14 > start + TS_PACKET_BYTES) return null;
    if (buffer[payload] !== 0 || buffer[payload + 1] !== 0 || buffer[payload + 2] !== 1) return null;
    const streamId = buffer[payload + 3];
    if (streamId < 0xe0 || streamId > 0xef || (buffer[payload + 7] & 0x80) === 0) return null;
    const pts = payload + 9;
    return ((buffer[pts] >> 1) & 0x07) * 2 ** 30
        + (((buffer[pts + 1] << 8) | buffer[pts + 2]) >> 1) * 2 ** 15
        + (((buffer[pts + 3] << 8) | buffer[pts + 4]) >> 1);
}

// The first video PES timestamp of an MPEG-TS file in 90 kHz ticks, as written
// (33 bits, before any demuxer unwraps it); null when the file has none.
export async function firstVideoPts(filePath: string): Promise<number | null> {
    const handle = await fs.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(READ_BYTES);
        for (let position = 0; ; position += READ_BYTES) {
            const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, position);
            for (let start = 0; start + TS_PACKET_BYTES <= bytesRead; start += TS_PACKET_BYTES) {
                const pts = videoPesPts(buffer, start);
                if (pts !== null) return pts;
            }
            if (bytesRead < READ_BYTES) return null;
        }
    } finally {
        await handle.close();
    }
}

// Seconds the 33-bit clock advanced from `from` to `to`; a real rollover reads
// as continuous, a reset as a negative advance.
export function ptsAdvanceSeconds(from: number, to: number): number {
    let ticks = (to - from) % PTS_WRAP;
    if (ticks < 0) ticks += PTS_WRAP;
    if (ticks >= PTS_WRAP / 2) ticks -= PTS_WRAP;
    return ticks / PTS_HZ;
}
