// MPEG-TS edits the simulator applies while serving: moving a segment's
// timestamps (so a looped source keeps rising like a real live stream) and
// cutting a segment down to its first video frame (a damage case).

const PACKET = 188;
const SYNC = 0x47;
const PTS_WRAP = 2 ** 33;

function pidOf(data: Buffer, at: number): number {
    return ((data[at + 1] & 0x1f) << 8) | data[at + 2];
}

function payloadStart(data: Buffer, at: number): number | null {
    const control = (data[at + 3] >> 4) & 0x3;
    if (!(control & 0x1)) return null;
    const start = control & 0x2 ? at + 5 + data[at + 4] : at + 4;
    return start < at + PACKET ? start : null;
}

function isUnitStart(data: Buffer, at: number): boolean {
    return (data[at + 1] & 0x40) !== 0;
}

function readTimestamp(data: Buffer, at: number): number {
    return ((data[at] >> 1) & 0x07) * 2 ** 30
        + (data[at + 1] << 22) + ((data[at + 2] >> 1) << 15)
        + (data[at + 3] << 7) + (data[at + 4] >> 1);
}

function writeTimestamp(data: Buffer, at: number, value: number): void {
    const prefix = data[at] & 0xf0;
    const high = Math.floor(value / 2 ** 30) & 0x07;
    const low = value % 2 ** 30;
    data[at] = prefix | (high << 1) | 0x01;
    data[at + 1] = (low >> 22) & 0xff;
    data[at + 2] = (((low >> 15) & 0x7f) << 1) | 0x01;
    data[at + 3] = (low >> 7) & 0xff;
    data[at + 4] = ((low & 0x7f) << 1) | 0x01;
}

function wrap(value: number): number {
    return ((value % PTS_WRAP) + PTS_WRAP) % PTS_WRAP;
}

export function isTransportStream(data: Buffer): boolean {
    return data.length >= PACKET && data.length % PACKET === 0 && data[0] === SYNC;
}

/**
 * Returns a copy with every PTS, DTS and PCR moved by `delta90k` ticks of the
 * 90 kHz clock. Bytes other than the timestamps are unchanged.
 */
export function shiftTimestamps(input: Buffer, delta90k: number): Buffer {
    const data = Buffer.from(input);
    if (delta90k === 0) return data;
    for (let at = 0; at + PACKET <= data.length; at += PACKET) {
        if (data[at] !== SYNC) continue;
        const control = (data[at + 3] >> 4) & 0x3;
        if (control & 0x2 && data[at + 4] >= 7 && data[at + 5] & 0x10) {
            const pcr = at + 6;
            const base = data.readUInt32BE(pcr) * 2 + (data[pcr + 4] >> 7);
            const shifted = wrap(base + delta90k);
            data.writeUInt32BE(Math.floor(shifted / 2), pcr);
            data[pcr + 4] = (data[pcr + 4] & 0x7f) | ((shifted & 1) << 7);
        }
        if (!isUnitStart(data, at)) continue;
        const pes = payloadStart(data, at);
        if (pes === null || pes + 14 > at + PACKET) continue;
        if (data[pes] !== 0 || data[pes + 1] !== 0 || data[pes + 2] !== 1) continue;
        const streamId = data[pes + 3];
        if (streamId < 0xc0 || streamId > 0xef) continue;
        const flags = data[pes + 7] >> 6;
        if (flags & 0x2) writeTimestamp(data, pes + 9, wrap(readTimestamp(data, pes + 9) + delta90k));
        if (flags === 0x3 && pes + 19 <= at + PACKET) {
            writeTimestamp(data, pes + 14, wrap(readTimestamp(data, pes + 14) + delta90k));
        }
    }
    return data;
}

/**
 * Payload-carrying packets per PID, modulo 16, over a run of segments: how
 * far each continuity counter advances in one pass of a source.
 */
export function continuitySteps(segments: Buffer[]): Record<string, number> {
    const steps: Record<string, number> = {};
    for (const data of segments) {
        for (let at = 0; at + PACKET <= data.length; at += PACKET) {
            if (data[at] !== SYNC || !(((data[at + 3] >> 4) & 0x1))) continue;
            const pid = pidOf(data, at);
            if (pid === 0x1fff) continue;
            steps[pid] = ((steps[pid] ?? 0) + 1) % 16;
        }
    }
    return steps;
}

/**
 * Advances each PID's continuity counter by `loops` passes of `steps`, so a
 * looped source continues the counters of the pass before (in place).
 */
export function advanceContinuity(data: Buffer, steps: Record<string, number>, loops: number): Buffer {
    if (loops === 0) return data;
    for (let at = 0; at + PACKET <= data.length; at += PACKET) {
        if (data[at] !== SYNC || !(((data[at + 3] >> 4) & 0x1))) continue;
        const step = steps[pidOf(data, at)];
        if (!step) continue;
        data[at + 3] = (data[at + 3] & 0xf0) | (((data[at + 3] & 0x0f) + step * loops) & 0x0f);
    }
    return data;
}

/** PIDs of the video elementary streams, from the first PAT and PMT. */
export function videoPids(data: Buffer): Set<number> {
    let pmtPid: number | null = null;
    const result = new Set<number>();
    for (let at = 0; at + PACKET <= data.length; at += PACKET) {
        if (data[at] !== SYNC || !isUnitStart(data, at)) continue;
        const pid = pidOf(data, at);
        const start = payloadStart(data, at);
        if (start === null) continue;
        const table = start + 1 + data[start];
        if (pid === 0 && pmtPid === null) {
            pmtPid = ((data[table + 10] & 0x1f) << 8) | data[table + 11];
        } else if (pid === pmtPid) {
            const sectionEnd = table + 3 + (((data[table + 1] & 0x0f) << 8) | data[table + 2]) - 4;
            const infoLength = ((data[table + 10] & 0x0f) << 8) | data[table + 11];
            for (let entry = table + 12 + infoLength; entry + 5 <= Math.min(sectionEnd, at + PACKET);) {
                const type = data[entry];
                const elementaryPid = ((data[entry + 1] & 0x1f) << 8) | data[entry + 2];
                if (type === 0x1b || type === 0x24 || type === 0x02) result.add(elementaryPid);
                entry += 5 + (((data[entry + 3] & 0x0f) << 8) | data[entry + 4]);
            }
            return result;
        }
    }
    return result;
}

/**
 * Keeps the packets before the second video access unit starts: a valid
 * transport stream holding one video frame and whatever audio came with it.
 * Returns the input unchanged when it holds a single frame already.
 */
export function truncateToFirstFrame(data: Buffer): Buffer {
    const video = videoPids(data);
    let seenFirst = false;
    for (let at = 0; at + PACKET <= data.length; at += PACKET) {
        if (data[at] !== SYNC || !isUnitStart(data, at) || !video.has(pidOf(data, at))) continue;
        if (seenFirst) return Buffer.from(data.subarray(0, at));
        seenFirst = true;
    }
    return Buffer.from(data);
}

/** The first video PTS in 90 kHz ticks, or null. */
export function firstVideoPts(data: Buffer): number | null {
    const video = videoPids(data);
    for (let at = 0; at + PACKET <= data.length; at += PACKET) {
        if (data[at] !== SYNC || !isUnitStart(data, at) || !video.has(pidOf(data, at))) continue;
        const pes = payloadStart(data, at);
        if (pes === null || data[pes + 7] >> 6 === 0) continue;
        return readTimestamp(data, pes + 9);
    }
    return null;
}
