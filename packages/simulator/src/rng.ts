// Deterministic "randomness": every value is a hash of the seed and a path of
// labels, so it never depends on call order and survives restarts.
import { createHash } from "node:crypto";

export function hashHex(...parts: Array<string | number>): string {
    return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

/** A uniform number in [0, 1). */
export function unit(...parts: Array<string | number>): number {
    return parseInt(hashHex(...parts).slice(0, 12), 16) / 2 ** 48;
}

/** An integer in [min, max]. */
export function intBetween(min: number, max: number, ...parts: Array<string | number>): number {
    return min + Math.floor(unit(...parts) * (max - min + 1));
}

export function sha256(data: Uint8Array | string): string {
    return createHash("sha256").update(data).digest("hex");
}
