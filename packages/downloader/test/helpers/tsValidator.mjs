import { stat } from 'node:fs/promises';
import { probeSegmentDimensions } from 'sdk';

// A TS site's segment check, as the capture tests' stand-in provider uses it: a
// non-empty file is valid, and its dimensions are probed (null when unknown).
export async function validateTsSegment(filePath) {
    try {
        if ((await stat(filePath)).size <= 0) return { valid: false };
    } catch {
        return { valid: false };
    }
    return { valid: true, dimensions: await probeSegmentDimensions(filePath) };
}
