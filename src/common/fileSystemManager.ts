import * as fsPromises from "fs/promises";
import logger from "./logger.js";

export class FileSystemManager {
    public static async readFile(filePath: string): Promise<string | null> {
        try {
            return await fsPromises.readFile(filePath, "utf-8");
        } catch (error: any) {
            if (error.code !== "ENOENT") {
                logger.error(`Failed to read file: ${filePath}`, { error: error.message });
            }
            return null;
        }
    }

    public static async writeFile(filePath: string, data: string | Uint8Array): Promise<boolean> {
        try {
            await fsPromises.writeFile(filePath, data);
            return true;
        } catch (error: any) {
            logger.error(`Failed to write file: ${filePath}`, { error: error.message });
            return false;
        }
    }

    public static async appendFile(filePath: string, data: string): Promise<boolean> {
        try {
            await fsPromises.appendFile(filePath, data);
            return true;
        } catch (error: any) {
            logger.error(`Failed to append to file: ${filePath}`, { error: error.message });
            return false;
        }
    }

    public static async pathExists(filePath: string): Promise<boolean> {
        try {
            await fsPromises.access(filePath);
            return true;
        } catch (error: any) {
            if (error.code === "ENOENT") {
                return false;
            }
            logger.error(`Error checking path existence: ${filePath}`, { error: error.message });
            return false;
        }
    }

    public static async readJsonFile<T>(filePath: string): Promise<T | null> {
        const fileContent = await this.readFile(filePath);
        if (fileContent === null) {
            return null;
        }
        try {
            return JSON.parse(fileContent) as T;
        } catch (error: any) {
            logger.error(`Failed to parse JSON from file: ${filePath}`, { error: error.message });
            return null;
        }
    }

    public static async writeJsonFile(filePath: string, data: object): Promise<boolean> {
        try {
            const jsonString = JSON.stringify(data, null, 2);
            return await this.writeFile(filePath, jsonString);
        } catch (error: any) {
            logger.error(`Failed to stringify JSON for file: ${filePath}`, { error: error.message });
            return false;
        }
    }

    public static async ensureDirExists(dirPath: string): Promise<boolean> {
        try {
            await fsPromises.mkdir(dirPath, { recursive: true });
            return true;
        } catch (error: any) {
            logger.error(`Failed to create directory: ${dirPath}`, { error: error.message });
            return false;
        }
    }
}
