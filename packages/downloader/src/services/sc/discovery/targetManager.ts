import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import * as utils from "../../../common/utils.js";
import logger from "../../../common/logger.js";
import { FILE_WATCHER_DEBOUNCE_MS } from "../../../common/timing.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ScTarget {
    username: string;
    roomId: string;
}

export class ScTargetManager {
    private targets: Map<string, ScTarget> = new Map(); // keyed by username
    private readonly filePath: string;
    private debounceTimer: NodeJS.Timeout | null = null;

    private constructor() {
        const projectRoot = utils.findProjectRoot(__dirname);
        this.filePath = path.join(projectRoot, "sc.txt");
        logger.info(`[SC] TargetManager initialized. Watching: ${this.filePath}`);
    }

    public static create(): ScTargetManager {
        const instance = new ScTargetManager();
        instance.loadTargets();
        instance.watchFile();
        return instance;
    }

    public getTargets(): ScTarget[] {
        return Array.from(this.targets.values());
    }

    public hasTarget(username: string): boolean {
        return this.targets.has(username);
    }

    public get size(): number {
        return this.targets.size;
    }

    private parseLine(line: string): ScTarget | null {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return null;

        let username = trimmed;
        let roomId = "";

        if (trimmed.includes("stripchat.com/")) {
            const parts = trimmed.split("stripchat.com/");
            if (!parts[1]) return null;
            const rest = parts[1].split("/")[0].split("?")[0];
            const spaceIdx = rest.indexOf(" ");
            if (spaceIdx !== -1) {
                username = rest.slice(0, spaceIdx);
                roomId = rest.slice(spaceIdx + 1);
            } else {
                username = rest;
                const fullSpaceIdx = trimmed.indexOf(" ", trimmed.indexOf("stripchat.com/"));
                if (fullSpaceIdx !== -1) {
                    roomId = trimmed.slice(fullSpaceIdx + 1).trim();
                }
            }
        }

        if (!username) return null;

        if (!roomId) {
            logger.warn(`[SC] Entry "${username}" has no roomId — add via API to resolve`);
        }

        return { username, roomId };
    }

    private loadTargets(): void {
        if (!fs.existsSync(this.filePath)) {
            logger.warn(`[SC] sc.txt not found at ${this.filePath}. Creating empty file.`);
            fs.writeFileSync(this.filePath, "# Add StripChat entries via the API (POST /api/sc/add)\n");
            return;
        }

        try {
            const content = fs.readFileSync(this.filePath, "utf-8");
            const newTargets = new Map<string, ScTarget>();

            for (const line of content.split("\n")) {
                const target = this.parseLine(line);
                if (target) {
                    newTargets.set(target.username, target);
                }
            }

            this.targets = newTargets;
            logger.info(`[SC] Loaded ${this.targets.size} targets: ${[...this.targets.keys()].join(", ")}`);
        } catch (error: any) {
            logger.error(`[SC] Error reading sc.txt`, { error: error.message });
        }
    }

    private watchFile(): void {
        fs.watch(this.filePath, (eventType) => {
            if (eventType === "change") {
                if (this.debounceTimer) clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    logger.info(`[SC] sc.txt changed. Reloading targets...`);
                    this.loadTargets();
                    this.debounceTimer = null;
                }, FILE_WATCHER_DEBOUNCE_MS);
            }
        });
    }
}
