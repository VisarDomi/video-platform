import { unlink } from "node:fs/promises";

// Deletes only the pipeline's own staging artifact after the upload was
// verified online. The original downloader/editor folders are never touched.
export async function cleanupArtifact(artifactPath: string): Promise<void> {
    try {
        await unlink(artifactPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}
