import { open } from "node:fs/promises";
import path from "node:path";

export async function syncFile(filePath: string): Promise<void> {
    const file = await open(filePath, "r");
    try { await file.sync(); } finally { await file.close(); }
}

// Flush bytes and directory entry before committing the finished artifact.
export async function syncPublishedArtifact(filePath: string): Promise<void> {
    await syncFile(filePath);
    const directory = await open(path.dirname(filePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
}
