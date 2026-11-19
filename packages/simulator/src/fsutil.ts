// Durable file writes: a reader sees either the old content or the new one,
// never a torn file, even across a power cut.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export function fsyncDir(dir: string): void {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function writeFileDurable(file: string, data: string | Uint8Array): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w");
    try {
        writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, file);
    fsyncDir(dirname(file));
}

export function writeJsonDurable(file: string, value: unknown): void {
    writeFileDurable(file, JSON.stringify(value, null, 2) + "\n");
}
