import * as fs from "fs";
import * as path from "path";
import { downloadListPath } from "shared";
import logger from "../../../common/logger.js";
import { FILE_WATCHER_DEBOUNCE_MS } from "../../../common/timing.js";

const TANGO_URL_PREFIX = "https://tango.me/";

export interface TangoTarget {
    accountId: string;
    alias: string;
}

export class TangoTargetManager {
    private targets: Map<string, TangoTarget> = new Map();
    private readonly filePath: string;
    private debounceTimer: NodeJS.Timeout | null = null;
    private watcher: fs.FSWatcher | null = null;

    private constructor(filePath?: string) {
        this.filePath = filePath ?? downloadListPath("tango");
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        logger.info(`[Tango] TargetManager initialized. Watching: ${this.filePath}`);
    }

    public static create(filePath?: string): TangoTargetManager {
        const instance = new TangoTargetManager(filePath);
        instance.loadTargets();
        instance.watchFile();
        return instance;
    }

    public hasTarget(accountId: string): boolean {
        return this.targets.has(accountId);
    }

    public getTargets(): TangoTarget[] {
        return Array.from(this.targets.values());
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
        }

        try {
            const previousTargets = new Map(this.targets);
            const content = fs.readFileSync(this.filePath, "utf-8");
            const newTargets = new Map<string, TangoTarget>();

            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(TANGO_URL_PREFIX)) continue;

                const match = trimmed.match(/^https:\/\/tango\.me\/([A-Za-z0-9_-]+)\/?\s+(.+)$/);
                if (!match) {
                    logger.warn(`[Tango] Invalid target line: ${trimmed}`);
                    continue;
                }
                const [, accountId, alias] = match;
                newTargets.set(accountId, { accountId, alias });
            }

            this.targets = newTargets;
            const added = [...newTargets.values()]
                .filter(target => !previousTargets.has(target.accountId))
                .map(target => `${target.alias} (${target.accountId})`);
            const removed = [...previousTargets.values()]
                .filter(target => !newTargets.has(target.accountId))
                .map(target => `${target.alias} (${target.accountId})`);
            const stats = fs.statSync(this.filePath);

            logger.info(
                `[Tango] Loaded ${this.targets.size} targets (added=${added.length}, removed=${removed.length}, mtime=${stats.mtime.toISOString()})`,
            );
            if (added.length > 0) {
                logger.info(`[Tango] Added targets: ${added.join(", ")}`);
            }
            if (removed.length > 0) {
                logger.info(`[Tango] Removed targets: ${removed.join(", ")}`);
            }
        } catch (error: any) {
            logger.error(`[Tango] Error reading tango.txt`, { error: error.message });
        }
    }

    public close(): void {
        this.watcher?.close();
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
    }

    private watchFile(): void {
        // Watch the directory so editor atomic-save renames don't orphan the watcher.
        this.watcher = fs.watch(path.dirname(this.filePath), (_eventType, filename) => {
            if (filename !== null && filename.toString() !== path.basename(this.filePath)) return;
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                logger.info(`[Tango] tango.txt changed. Reloading targets...`);
                this.loadTargets();
                this.debounceTimer = null;
            }, FILE_WATCHER_DEBOUNCE_MS);
        });
    }
}
