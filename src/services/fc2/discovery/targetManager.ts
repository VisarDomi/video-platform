import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import * as utils from "../../../common/utils.js";
import logger from "../../../common/logger.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class TargetManager {
    private targets: Set<string> = new Set();
    private readonly targetsFilePath: string;
    private debounceTimer: NodeJS.Timeout | null = null;

    private constructor() {
        const projectRoot = utils.findProjectRoot(__dirname);
        this.targetsFilePath = path.join(projectRoot, "fc2.txt");
        logger.info(`[FC2] TargetManager initialized. Watching: ${this.targetsFilePath}`);
    }

    public static create(): TargetManager {
        const instance = new TargetManager();
        instance.loadTargets();
        instance.watchFile();
        return instance;
    }

    public getTargets(): string[] {
        return Array.from(this.targets);
    }

    private loadTargets(): void {
        if (!fs.existsSync(this.targetsFilePath)) {
            logger.warn(`[FC2] fc2.txt not found at ${this.targetsFilePath}. Creating empty file.`);
            fs.writeFileSync(this.targetsFilePath, "# Add FC2 Channel IDs here, one per line\n");
            return;
        }

        try {
            const content = fs.readFileSync(this.targetsFilePath, "utf-8");
            const lines = content.split("\n");
            const newTargets = new Set<string>();

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith("#")) {
                    newTargets.add(trimmed);
                }
            }

            this.targets = newTargets;
            logger.info(`[FC2] Loaded ${this.targets.size} targets.`);
        } catch (error: any) {
            logger.error("[FC2] Error reading fc2.txt", { error: error.message });
        }
    }

    private watchFile(): void {
        fs.watch(this.targetsFilePath, (eventType) => {
            if (eventType === "change") {
                if (this.debounceTimer) clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    logger.info("[FC2] fc2.txt changed. Reloading targets...");
                    this.loadTargets();
                    this.debounceTimer = null;
                }, 500);
            }
        });
    }
}