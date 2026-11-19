import * as fs from "fs";
import * as path from "path";
import type { Catalog, Logger, Target } from "sdk";
import { FILE_WATCHER_DEBOUNCE_MS } from "../../common/timing.js";

export interface TargetManagerOptions {
    filePath: string;
    // The site's own list format.
    catalog: Pick<Catalog, "parseTargetLine" | "listHeader" | "listChangesBy" | "describeTarget">;
    // The site's logger ("[<label>] ...").
    log: Logger;
}

// A site's download list: one target per line in the site's format, read through its
// catalog and reloaded whenever the file changes. An entry the site has not resolved to
// an ID yet is kept under its label; it counts as listed but is never looked up. A
// repeated ID keeps its first position and takes the last line's label. A missing list
// is created with the catalog's header and not read: the targets stay as they were (none
// at startup), and the next change of the file loads it.
export class TargetManager {
    private targets = new Map<string, Target>();
    private loaded = false;
    private readonly filePath: string;
    private readonly fileName: string;
    private readonly catalog: TargetManagerOptions["catalog"];
    private readonly log: Logger;
    private debounceTimer: NodeJS.Timeout | null = null;
    private watcher: fs.FSWatcher | null = null;

    private constructor(options: TargetManagerOptions) {
        this.filePath = options.filePath;
        this.fileName = path.basename(options.filePath);
        this.catalog = options.catalog;
        this.log = options.log;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.log.debug(`TargetManager initialized. Watching: ${this.filePath}`);
    }

    public static create(options: TargetManagerOptions): TargetManager {
        const instance = new TargetManager(options);
        instance.loadTargets();
        instance.watchFile();
        return instance;
    }

    public getTargets(): Target[] {
        return Array.from(this.targets.values());
    }

    public hasTarget(id: string): boolean {
        return this.targets.has(id);
    }

    public get size(): number {
        return this.targets.size;
    }

    public close(): void {
        this.watcher?.close();
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
    }

    private loadTargets(): void {
        if (!fs.existsSync(this.filePath)) {
            this.log.warn(`${this.fileName} not found at ${this.filePath}. Creating empty file.`);
            fs.writeFileSync(this.filePath, `${this.catalog.listHeader ?? "# One target per line"}\n`);
            return;
        }

        try {
            const content = fs.readFileSync(this.filePath, "utf-8");
            const next = new Map<string, Target>();
            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) continue;
                const target = this.catalog.parseTargetLine(trimmed);
                if (target) next.set(target.id || target.label, target);
            }

            const previous = this.targets;
            this.targets = next;
            // The first load reports the count; a reload reports only what changed.
            if (!this.loaded) {
                this.loaded = true;
                this.log.info(`Loaded ${next.size} targets`);
                return;
            }
            const { added, removed } = this.changes(previous, next);
            if (added.length > 0) this.log.info(`Added targets: ${added.join(", ")}`);
            if (removed.length > 0) this.log.info(`Removed targets: ${removed.join(", ")}`);
        } catch (error: any) {
            this.log.error(`Error reading ${this.fileName}`, { error: error.message });
        }
    }

    private changes(previous: Map<string, Target>, next: Map<string, Target>): { added: string[]; removed: string[] } {
        const describe = (target: Target) => this.catalog.describeTarget?.(target) ?? `${target.label} (${target.id})`;
        if (this.catalog.listChangesBy === "entry") {
            const before = new Set([...previous.values()].map(describe));
            const after = new Set([...next.values()].map(describe));
            return {
                added: [...after].filter((entry) => !before.has(entry)),
                removed: [...before].filter((entry) => !after.has(entry)),
            };
        }
        return {
            added: [...next].filter(([key]) => !previous.has(key)).map(([, target]) => describe(target)),
            removed: [...previous].filter(([key]) => !next.has(key)).map(([, target]) => describe(target)),
        };
    }

    private watchFile(): void {
        // Watch the directory, not the file: the server replaces the list atomically
        // (write a temporary file, rename it over the list), which would orphan a
        // watcher on the old file and stop every later reload.
        this.watcher = fs.watch(path.dirname(this.filePath), (_eventType, filename) => {
            if (filename !== null && filename.toString() !== this.fileName) return;
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                this.log.debug(`${this.fileName} changed. Reloading targets...`);
                this.loadTargets();
                this.debounceTimer = null;
            }, FILE_WATCHER_DEBOUNCE_MS);
        });
    }
}
