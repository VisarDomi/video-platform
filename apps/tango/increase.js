import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const configPath = resolve(__dirname, "package.json");
const encoding = "utf-8";

console.log(`Reading ${configPath}...`);

const content = readFileSync(configPath, { encoding });
const pkg = JSON.parse(content);

const currentVersion = pkg.version;
console.log(`Found current version: ${currentVersion}`);

const newVersion = (parseInt(currentVersion, 10) + 1).toString();

console.log(`Incrementing to: ${newVersion}`);

pkg.version = newVersion;

writeFileSync(configPath, JSON.stringify(pkg, null, 2) + "\n", { encoding });

console.log("package.json has been updated successfully.");
