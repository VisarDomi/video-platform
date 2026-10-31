import { createHash } from "node:crypto";
import type { Stats } from "node:fs";

export function mp4Identity(stat: Pick<Stats, "dev" | "ino" | "birthtimeMs">): string {
    return createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`).digest("hex").slice(0, 24);
}
export class MP4RenameError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}
export function mp4RenameName(value: unknown): string {
    if (typeof value !== "string") throw new MP4RenameError(400, "Enter a filename");
    let name = value.trim().normalize("NFC");
    if (!name || name.startsWith(".") || /[\x00-\x1f\x7f/\\]/.test(name)) throw new MP4RenameError(400, "Use a filename without folders or control characters");
    if (!/\.mp4$/i.test(name)) name += ".mp4";
    if (Buffer.byteLength(name, "utf8") > 255) throw new MP4RenameError(400, "The filename is too long");
    return name;
}
export interface MP4Rename {
    version: 1; fileId: string; from: string; to: string; bytes: number; jobs: string[]; stage: "prepared" | "linked";
}
export interface MP4RenameHooks {
    prepare(from: string, to: string, fileId: string, bytes: number): Promise<string[]>;
    commit(rename: MP4Rename): Promise<void>;
}
