import { constants, promises as fs } from "fs";
import * as path from "path";

export class FileSystemManager {
    public static async readFile(filePath: string): Promise<string | null> {
        try {
            return await fs.readFile(filePath, "utf-8");
        } catch (error: any) {
            if (error.code !== "ENOENT") {
                console.error(`Failed to read file: ${filePath}`, error.message);
            }
            return null;
        }
    }

    public static async writeFile(filePath: string, data: string | Uint8Array): Promise<boolean> {
        try {
            await fs.writeFile(filePath, data);
            return true;
        } catch (error: any) {
            console.error(`Failed to write file: ${filePath}`, error.message);
            return false;
        }
    }

    public static async writeFileExclusive(filePath: string, data: string | Uint8Array): Promise<boolean> {
        try {
            await fs.writeFile(filePath, data, { flag: "wx" });
            return true;
        } catch (error: any) {
            if (error.code !== "EEXIST") {
                console.error(`Failed to exclusively write file: ${filePath}`, error.message);
            }
            return false;
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
            console.error(`Failed to atomically write file: ${filePath}`, error.message);
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
            console.error(`Failed to append to file: ${filePath}`, error.message);
            return false;
        }
    }

    public static async pathExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch (error: any) {
            if (error.code === "ENOENT") return false;
            console.error(`Error checking path existence: ${filePath}`, error.message);
            return false;
        }
    }

    public static async readJsonFile<T>(filePath: string): Promise<T | null> {
        const content = await this.readFile(filePath);
        if (content === null) return null;
        try {
            return JSON.parse(content) as T;
        } catch (error: any) {
            console.error(`Failed to parse JSON from file: ${filePath}`, error.message);
            return null;
        }
    }

    public static async writeJsonFile(filePath: string, data: object): Promise<boolean> {
        try {
            return await this.writeFileAtomic(filePath, JSON.stringify(data, null, 2));
        } catch (error: any) {
            console.error(`Failed to stringify JSON for file: ${filePath}`, error.message);
            return false;
        }
    }

    public static async ensureDirExists(dirPath: string): Promise<boolean> {
        try {
            await fs.mkdir(dirPath, { recursive: true });
            return true;
        } catch (error: any) {
            console.error(`Failed to create directory: ${dirPath}`, error.message);
            return false;
        }
    }
}
