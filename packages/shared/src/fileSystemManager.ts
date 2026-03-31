import { promises as fs } from "fs";

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
            return await this.writeFile(filePath, JSON.stringify(data, null, 2));
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
