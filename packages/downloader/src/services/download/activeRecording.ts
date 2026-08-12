import { constants, promises as fs } from "fs";
import * as path from "path";
import { fixTargetDuration } from "shared";
import { FileSystemManager } from "../../common/fileSystemManager.js";

export async function handoffActiveRecording(activePath: string): Promise<string> {
    const activeRoot = path.dirname(activePath);
    if (path.basename(activeRoot) !== ".active") {
        throw new Error(`Refusing to hand off a recording outside .active: ${activePath}`);
    }

    const downloaderRoot = path.dirname(activeRoot);
    const pendingRoot = path.join(downloaderRoot, ".pending");
    const destinationPath = path.join(pendingRoot, path.basename(activePath));
    await fs.mkdir(pendingRoot, { recursive: true });
    try {
        await fs.lstat(destinationPath);
        throw new Error(`Pending recording destination already exists: ${destinationPath}`);
    } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
    }

    await fs.rename(activePath, destinationPath);
    for (const directoryPath of [activeRoot, pendingRoot, downloaderRoot]) {
        const directory = await fs.open(directoryPath, constants.O_RDONLY);
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    }
    return destinationPath;
}

export async function finalizeInactiveRecording(activePath: string): Promise<string> {
    const playlistPath = path.join(activePath, "playlist.m3u8");
    const content = await fs.readFile(playlistPath, "utf8");
    const withoutEndlist = content.split(/\r?\n/)
        .filter((line) => line.trim() !== "#EXT-X-ENDLIST")
        .join("\n")
        .replace(/\n*$/, "\n");
    const { content: fixed } = fixTargetDuration(`${withoutEndlist}#EXT-X-ENDLIST\n`);
    if (!await FileSystemManager.writeFileAtomic(playlistPath, fixed)) {
        throw new Error(`Could not atomically finalize ${playlistPath}`);
    }
    return handoffActiveRecording(activePath);
}
