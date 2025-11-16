import fs from 'fs';
import path from 'path';
import url from "url";

/**
 * Finds the project root by searching upwards from the given directory for a package.json file.
 * @param {string} startDir - The directory to start the search from. Defaults to the directory of the current module.
 * @returns {string} The absolute path to the project root.
 * @throws {Error} If package.json is not found.
 */
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export function findProjectRoot(): string {
  let currentDir = __dirname;
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