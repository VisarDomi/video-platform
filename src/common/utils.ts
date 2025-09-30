// src/common/utils.ts
import fs from 'fs';
import path from 'path';

export function getFormattedDate(date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}${minutes}${seconds}`;
}    


/**
 * Finds the project root by searching upwards from the given directory for a package.json file.
 * @param {string} startDir - The directory to start the search from. Defaults to the directory of the current module.
 * @returns {string} The absolute path to the project root.
 * @throws {Error} If package.json is not found.
 */
export function findProjectRoot(startDir: string = __dirname): string {
  let currentDir = startDir;
  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    // If we've reached the file system root and haven't found it
    if (parentDir === currentDir) {
      throw new Error('Could not find project root containing a package.json.');
    }
    currentDir = parentDir;
  }
}