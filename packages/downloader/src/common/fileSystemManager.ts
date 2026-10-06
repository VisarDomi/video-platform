import { constants, promises as fs } from "fs";
import * as path from "path";
import logger from "./logger.js";

export class FileSystemManager {
    public static async readFile(filePath: string): Promise<string | null> {
        try {
            return await fs.readFile(filePath, "utf-8");
        } catch (error: any) {
            if (error.code !== "ENOENT") {
                logger.error(`Failed to read file: ${filePath}`, { error: error.message });
            }
            return null;
        }
    }

    public static async writeFile(filePath: string, data: string | Uint8Array): Promise<boolean> {
        try {
            await fs.writeFile(filePath, data);
            return true;
        } catch (error: any) {
            logger.error(`Failed to write file: ${filePath}`, { error: error.message });
            return false;
        }
    }

    // Never overwrites: "exists" when the name is taken, "failed" (logged) otherwise.
    public static async writeFileExclusive(filePath: string, data: string | Uint8Array): Promise<"written" | "exists" | "failed"> {
        try {
            await fs.writeFile(filePath, data, { flag: "wx" });
            return "written";
        } catch (error: any) {
            if (error.code === "EEXIST") return "exists";
            logger.error(`Failed to exclusively write file: ${filePath}`, { error: error.message });
            return "failed";
        }
    }

    public static async writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<boolean> {
        const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
        let handle;
        try {
            handle = await fs.open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
            await handle.writeFile(data);
            await handle.sync();
            await handle.close();
            handle = undefined;
            await fs.rename(tempPath, filePath);
            const directory = await fs.open(path.dirname(filePath), constants.O_RDONLY);
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
            return true;
        } catch (error: any) {
            logger.error(`Failed to atomically write file: ${filePath}`, { error: error.message });
            await handle?.close().catch(() => {});
            await fs.unlink(tempPath).catch(() => {});
            return false;
        }
    }

    public static async appendFile(filePath: string, data: string): Promise<boolean> {
        try {
            await fs.appendFile(filePath, data);
            return true;
        } catch (error: any) {
            logger.error(`Failed to append to file: ${filePath}`, { error: error.message });
            return false;
        }
    }

    public static async pathExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch (error: any) {
            if (error.code === "ENOENT") return false;
            logger.error(`Error checking path existence: ${filePath}`, { error: error.message });
            return false;
        }
    }

    public static async readJsonFile<T>(filePath: string): Promise<T | null> {
        const content = await this.readFile(filePath);
        if (content === null) return null;
        try {
            return JSON.parse(content) as T;
        } catch (error: any) {
            logger.error(`Failed to parse JSON from file: ${filePath}`, { error: error.message });
            return null;
        }
    }

    public static async writeJsonFile(filePath: string, data: object): Promise<boolean> {
        try {
            return await this.writeFileAtomic(filePath, JSON.stringify(data, null, 2));
        } catch (error: any) {
            logger.error(`Failed to stringify JSON for file: ${filePath}`, { error: error.message });
            return false;
        }
    }

    public static async ensureDirExists(dirPath: string): Promise<boolean> {
        try {
            await fs.mkdir(dirPath, { recursive: true });
            return true;
        } catch (error: any) {
            logger.error(`Failed to create directory: ${dirPath}`, { error: error.message });
            return false;
        }
    }
}
