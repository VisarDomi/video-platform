import { normalizeRecordingId } from "sdk";

// The stored form of recording identities is shared with the site plug-ins.
export { normalizeRecordingId };

const SAFE_RECORDING_ID = /^[A-Za-z0-9._-]+$/;

export interface CompoundSegmentIdentity {
    localNumber: number;
    recordingId: string;
    providerSequence: number;
}

function filenameRecordingId(recordingId: string): string {
    const normalized = normalizeRecordingId(recordingId);
    if (!SAFE_RECORDING_ID.test(normalized)) {
        throw new Error(`Recording identity cannot be represented safely in a filename: ${recordingId}`);
    }
    return normalized;
}

export function formatSegmentName(
    localNumber: number,
    recordingId: string,
    providerSequence: number,
): string {
    return `${localNumber}_${filenameRecordingId(recordingId)}_${providerSequence}.ts`;
}

export function parseCompoundSegmentName(name: string): CompoundSegmentIdentity | null {
    const match = name.match(/^(\d+)_(.+)_(-?\d+)\.ts$/);
    if (!match) return null;

    const localNumber = Number.parseInt(match[1], 10);
    const providerSequence = Number.parseInt(match[3], 10);
    if (!Number.isSafeInteger(localNumber) || !Number.isSafeInteger(providerSequence)) return null;

    try {
        const decodedRecordingId = match[2].includes("%")
            ? decodeURIComponent(match[2])
            : match[2];
        return {
            localNumber,
            recordingId: normalizeRecordingId(decodedRecordingId),
            providerSequence,
        };
    } catch {
        return null;
    }
}
