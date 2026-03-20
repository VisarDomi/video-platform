import fs from 'fs';
import path from 'path';
import url from "url";
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
    if (parentDir === currentDir) {
      throw new Error('Could not find project root containing a package.json.');
    }
    currentDir = parentDir;
  }
}