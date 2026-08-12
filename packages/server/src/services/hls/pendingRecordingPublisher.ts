import { constants, promises as fs } from "node:fs";
import path from "node:path";

async function syncDirectory(directoryPath: string): Promise<void> {
    const directory = await fs.open(directoryPath, constants.O_RDONLY);
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

export function pendingRoot(finalizedRoot: string): string {
    return path.join(finalizedRoot, ".pending");
}

export async function publishPendingRecording(pendingPath: string): Promise<string> {
    const resolvedPendingPath = path.resolve(pendingPath);
    const resolvedPendingRoot = path.dirname(resolvedPendingPath);
    if (path.basename(resolvedPendingRoot) !== ".pending") {
        throw new Error(`Refusing to publish a recording outside .pending: ${pendingPath}`);
    }

    const finalizedRoot = path.dirname(resolvedPendingRoot);
    const destinationPath = path.join(finalizedRoot, path.basename(resolvedPendingPath));
    try {
        await fs.lstat(destinationPath);
        throw new Error(`Finalized recording destination already exists: ${destinationPath}`);
    } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
    }

    await fs.rename(resolvedPendingPath, destinationPath);
    await syncDirectory(resolvedPendingRoot);
    await syncDirectory(finalizedRoot);
    return destinationPath;
}
