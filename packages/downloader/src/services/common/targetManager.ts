import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import * as utils from "../../common/utils.js";
import logger from "../../common/logger.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TargetManagerOptions {
    label: string;
    fileName: string;
    parseIdentifier: (line: string) => string | null;
    defaultComment: string;
}

export class TargetManager {
    private targets: Set<string> = new Set();
    private readonly targetsFilePath: string;
    private readonly label: string;
    private readonly parseIdentifier: (line: string) => string | null;
    private readonly defaultComment: string;
    private debounceTimer: NodeJS.Timeout | null = null;

    private constructor(options: TargetManagerOptions) {
        const projectRoot = utils.findProjectRoot(__dirname);
        this.targetsFilePath = path.join(projectRoot, options.fileName);
        this.label = options.label;
        this.parseIdentifier = options.parseIdentifier;
        this.defaultComment = options.defaultComment;
        logger.info(`[${this.label}] TargetManager initialized. Watching: ${this.targetsFilePath}`);
    }

    public static create(options: TargetManagerOptions): TargetManager {
        const instance = new TargetManager(options);
        instance.loadTargets();
        instance.watchFile();
        return instance;
    }

    public getTargets(): string[] {
        return Array.from(this.targets);
    }

    public hasTarget(identifier: string): boolean {
        return this.targets.has(identifier);
    }

    public get size(): number {
        return this.targets.size;
    }

    private loadTargets(): void {
        if (!fs.existsSync(this.targetsFilePath)) {
            logger.warn(`[${this.label}] ${path.basename(this.targetsFilePath)} not found at ${this.targetsFilePath}. Creating empty file.`);
            fs.writeFileSync(this.targetsFilePath, this.defaultComment + "\n");
            return;
        }

        try {
            const content = fs.readFileSync(this.targetsFilePath, "utf-8");
            const lines = content.split("\n");
            const newTargets = new Set<string>();

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith("#")) {
                    const id = this.parseIdentifier(trimmed);
                    if (id) {
                        newTargets.add(id);
                    } else {
                        logger.warn(`[${this.label}] Could not parse identifier from line: "${trimmed}"`);
                    }
                }
            }

            this.targets = newTargets;
            logger.info(`[${this.label}] Loaded ${this.targets.size} targets: ${[...this.targets].join(", ")}`);
        } catch (error: any) {
            logger.error(`[${this.label}] Error reading ${path.basename(this.targetsFilePath)}`, { error: error.message });
        }
    }

    private watchFile(): void {
        fs.watch(this.targetsFilePath, (eventType) => {
            if (eventType === "change") {
                if (this.debounceTimer) clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    logger.info(`[${this.label}] ${path.basename(this.targetsFilePath)} changed. Reloading targets...`);
                    this.loadTargets();
                    this.debounceTimer = null;
                }, 500);
            }
        });
    }
}
