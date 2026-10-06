import * as fs from "fs";
import * as path from "path";
import { downloadListPath } from "shared";
import logger from "../../../common/logger.js";
import { FILE_WATCHER_DEBOUNCE_MS } from "../../../common/timing.js";

export interface ScTarget {
    roomId: string;
    username: string;
}

export class ScTargetManager {
    private targets: Map<string, ScTarget> = new Map();
    private loaded = false;
    private readonly filePath: string;
    private debounceTimer: NodeJS.Timeout | null = null;

    private constructor() {
        this.filePath = downloadListPath("sc");
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        logger.debug(`[SC] TargetManager initialized. Watching: ${this.filePath}`);
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

    public hasTarget(roomId: string): boolean {
        return this.targets.has(roomId);
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
                    newTargets.set(target.roomId || target.username, target);
                }
            }

            const describe = (target: ScTarget) => `${target.username} (${target.roomId})`;
            const previous = new Set([...this.targets.values()].map(describe));
            const next = new Set([...newTargets.values()].map(describe));
            this.targets = newTargets;
            // The first load reports the count; a reload reports only what changed.
            if (!this.loaded) {
                this.loaded = true;
                logger.info(`[SC] Loaded ${this.targets.size} targets`);
                return;
            }
            const added = [...next].filter((entry) => !previous.has(entry));
            const removed = [...previous].filter((entry) => !next.has(entry));
            if (added.length > 0) logger.info(`[SC] Added targets: ${added.join(", ")}`);
            if (removed.length > 0) logger.info(`[SC] Removed targets: ${removed.join(", ")}`);
        } catch (error: any) {
            logger.error(`[SC] Error reading sc.txt`, { error: error.message });
        }
    }

    private watchFile(): void {
        fs.watch(this.filePath, (eventType) => {
            if (eventType === "change") {
                if (this.debounceTimer) clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    logger.debug(`[SC] sc.txt changed. Reloading targets...`);
                    this.loadTargets();
                    this.debounceTimer = null;
                }, FILE_WATCHER_DEBOUNCE_MS);
            }
        });
    }
}
