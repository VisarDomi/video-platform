import * as fs from "fs";
import * as path from "path";
import logger from "../../common/logger.js";
import { FILE_WATCHER_DEBOUNCE_MS } from "../../common/timing.js";

interface TargetManagerOptions {
    label: string;
    filePath: string;
    parseIdentifier: (line: string) => string | null;
    defaultComment: string;
}

export class TargetManager {
    private targets: Set<string> = new Set();
    private loaded = false;
    private readonly targetsFilePath: string;
    private readonly label: string;
    private readonly parseIdentifier: (line: string) => string | null;
    private readonly defaultComment: string;
    private debounceTimer: NodeJS.Timeout | null = null;
    private watcher: fs.FSWatcher | null = null;

    private constructor(options: TargetManagerOptions) {
        this.targetsFilePath = options.filePath;
        fs.mkdirSync(path.dirname(this.targetsFilePath), { recursive: true });
        this.label = options.label;
        this.parseIdentifier = options.parseIdentifier;
        this.defaultComment = options.defaultComment;
        logger.debug(`[${this.label}] TargetManager initialized. Watching: ${this.targetsFilePath}`);
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
            const previousTargets = new Set(this.targets);
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
            const added = [...newTargets].filter(id => !previousTargets.has(id));
            const removed = [...previousTargets].filter(id => !newTargets.has(id));
            // The first load reports the count; a reload reports only what changed.
            if (!this.loaded) {
                this.loaded = true;
                logger.info(`[${this.label}] Loaded ${this.targets.size} targets`);
                return;
            }
            if (added.length > 0) {
                logger.info(`[${this.label}] Added targets: ${added.join(", ")}`);
            }
            if (removed.length > 0) {
                logger.info(`[${this.label}] Removed targets: ${removed.join(", ")}`);
            }
        } catch (error: any) {
            logger.error(`[${this.label}] Error reading ${path.basename(this.targetsFilePath)}`, { error: error.message });
        }
    }

    public close(): void {
        this.watcher?.close();
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
    }

    private watchFile(): void {
        // Watch the directory, not the file: the server replaces the list atomically
        // (write a temporary file, rename it over the list), which would orphan a
        // watcher on the old file and stop every later reload.
        const name = path.basename(this.targetsFilePath);
        this.watcher = fs.watch(path.dirname(this.targetsFilePath), (_eventType, filename) => {
            if (filename !== null && filename.toString() !== name) return;
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                logger.debug(`[${this.label}] ${name} changed. Reloading targets...`);
                this.loadTargets();
                this.debounceTimer = null;
            }, FILE_WATCHER_DEBOUNCE_MS);
        });
    }
}
