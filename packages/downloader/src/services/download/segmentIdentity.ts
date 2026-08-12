import { formatTimestampForPath } from "../../common/pathTimestamp.js";

export const RECOVERY_DEDUP_TAIL_SIZE = 10;
const SAFE_RECORDING_ID = /^[A-Za-z0-9._-]+$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export interface CompoundSegmentIdentity {
    localNumber: number;
    recordingId: string;
    providerSequence: number;
}

export interface ProviderSegmentIdentity {
    recordingId: string;
    providerSequence: number;
}

export function normalizeRecordingId(recordingId: string): string {
    if (UTC_TIMESTAMP.test(recordingId)) {
        return formatTimestampForPath(new Date(recordingId), true);
    }
    return recordingId;
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

export function providerSegmentKey(identity: ProviderSegmentIdentity): string {
    return `${identity.recordingId}\0${identity.providerSequence}`;
}
