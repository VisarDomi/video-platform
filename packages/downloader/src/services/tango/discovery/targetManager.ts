import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import * as utils from "../../../common/utils.js";
import logger from "../../../common/logger.js";
import { FILE_WATCHER_DEBOUNCE_MS } from "../../../common/timing.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TANGO_URL_PREFIX = "https://tango.me/";

export interface TangoTarget {
    accountId: string;
    alias: string;
}

export class TangoTargetManager {
    private targets: Map<string, TangoTarget> = new Map();
    private readonly filePath: string;
    private debounceTimer: NodeJS.Timeout | null = null;

    private constructor() {
        const projectRoot = utils.findProjectRoot(__dirname);
        this.filePath = path.join(projectRoot, "tango.txt");
        logger.info(`[Tango] TargetManager initialized. Watching: ${this.filePath}`);
    }

    public static create(): TangoTargetManager {
        const instance = new TangoTargetManager();
        instance.loadTargets();
        instance.watchFile();
        return instance;
    }

    public hasTarget(accountId: string): boolean {
        return this.targets.has(accountId);
    }

    public getAlias(accountId: string): string | undefined {
        return this.targets.get(accountId)?.alias;
    }

    public get size(): number {
        return this.targets.size;
    }

    private loadTargets(): void {
        if (!fs.existsSync(this.filePath)) {
            logger.warn(`[Tango] tango.txt not found at ${this.filePath}. Creating empty file.`);
            fs.writeFileSync(this.filePath, "# Add Tango URLs here: https://tango.me/{accountId} {alias}\n");
            return;
        }

        try {
            const content = fs.readFileSync(this.filePath, "utf-8");
            const newTargets = new Map<string, TangoTarget>();

            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(TANGO_URL_PREFIX)) continue;

                const rest = trimmed.slice(TANGO_URL_PREFIX.length);
                const spaceIdx = rest.indexOf(" ");
                if (spaceIdx === -1) continue;

                const accountId = rest.slice(0, spaceIdx);
                const alias = rest.slice(spaceIdx + 1);
                newTargets.set(accountId, { accountId, alias });
            }

            this.targets = newTargets;
            logger.info(`[Tango] Loaded ${this.targets.size} targets: ${[...this.targets.keys()].join(", ")}`);
        } catch (error: any) {
            logger.error(`[Tango] Error reading tango.txt`, { error: error.message });
        }
    }

    private watchFile(): void {
        fs.watch(this.filePath, (eventType) => {
            if (eventType === "change") {
                if (this.debounceTimer) clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    logger.info(`[Tango] tango.txt changed. Reloading targets...`);
                    this.loadTargets();
                    this.debounceTimer = null;
                }, FILE_WATCHER_DEBOUNCE_MS);
            }
        });
    }
}
