import { promises as fs } from "node:fs";
import { SDK_VERSION, type PluginContext, type SiteInstance, type SitePlugin } from "./plugin.js";

// The sites file names every site a deployment runs, the plug-in package that
// implements it, and that plug-in's own configuration:
//
//   { "sites": [ { "id": "live-a", "plugin": "plugin-ts-live", "config": { ... } } ] }
//
// Site IDs are data: they name download lists, recording folders and API routes, so a
// production deployment keeps the IDs its folders and ledger already use.

export interface SiteEntry {
    id: string;
    plugin: string;
    enabled?: boolean;
    // The account whose credentials the site's consumers use (its session file in the
    // core's credential store). Required for a site with auth.
    account?: string;
    config?: Record<string, unknown>;
}

export interface LoadedSite {
    id: string;
    plugin: SitePlugin;
    entry: SiteEntry;
    instance: SiteInstance;
}

export interface LoadOptions {
    // Resolves a plug-in package; defaults to a dynamic import of its name.
    importPlugin?: (specifier: string) => Promise<unknown>;
    // Builds each instance's context (store, paths, logger, clock) in the host process.
    context: (entry: SiteEntry, plugin: SitePlugin) => PluginContext;
}

const SITE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Whether a value has the form of a site ID (it names folders, lists and routes).
export function isSiteId(value: unknown): value is string {
    return typeof value === "string" && SITE_ID.test(value);
}

export function parseSitesFile(text: string, source = "sites file"): SiteEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error: any) {
        throw new Error(`${source}: invalid JSON (${error.message})`);
    }
    const sites = (parsed as { sites?: unknown })?.sites;
    if (!Array.isArray(sites)) throw new Error(`${source}: expected {"sites": [...]}`);
    const seen = new Set<string>();
    return sites.map((raw, index) => {
        const entry = raw as SiteEntry;
        const where = `${source}: sites[${index}]`;
        if (typeof entry?.id !== "string" || !SITE_ID.test(entry.id)) throw new Error(`${where}: invalid id ${JSON.stringify(entry?.id)}`);
        if (seen.has(entry.id)) throw new Error(`${where}: duplicate id ${entry.id}`);
        seen.add(entry.id);
        if (typeof entry.plugin !== "string" || !entry.plugin) throw new Error(`${where}: plugin is required`);
        if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw new Error(`${where}: enabled must be a boolean`);
        if (entry.config !== undefined && (typeof entry.config !== "object" || entry.config === null || Array.isArray(entry.config))) {
            throw new Error(`${where}: config must be an object`);
        }
        if (entry.account !== undefined && (typeof entry.account !== "string" || !entry.account || entry.account.includes("/"))) {
            throw new Error(`${where}: account must be a non-empty name without "/"`);
        }
        return { id: entry.id, plugin: entry.plugin, enabled: entry.enabled ?? true,
            ...(entry.account !== undefined ? { account: entry.account } : {}), config: entry.config ?? {} };
    });
}

export async function readSitesFile(filePath: string): Promise<SiteEntry[]> {
    // A missing sites file is an error, not "no sites": running with no sites would
    // silently stop every capture.
    return parseSitesFile(await fs.readFile(filePath, "utf-8"), filePath);
}

export async function loadSites(entries: SiteEntry[], options: LoadOptions): Promise<LoadedSite[]> {
    const importPlugin = options.importPlugin ?? ((specifier: string) => import(specifier));
    const created: SiteInstance[] = [];
    const loaded: LoadedSite[] = [];
    try {
        for (const entry of entries) {
            if (entry.enabled === false) continue;
            const module = await importPlugin(entry.plugin) as { default?: unknown; plugin?: unknown };
            const plugin = (module.plugin ?? module.default) as SitePlugin | undefined;
            if (!plugin || typeof plugin.create !== "function") {
                throw new Error(`Site ${entry.id}: ${entry.plugin} does not export a plug-in`);
            }
            if (plugin.sdkVersion !== SDK_VERSION) {
                throw new Error(`Site ${entry.id}: ${entry.plugin} targets SDK ${plugin.sdkVersion}, this core runs SDK ${SDK_VERSION}`);
            }
            const instance = await plugin.create(options.context(entry, plugin));
            created.push(instance);
            // Consumers read the site's credentials through the account the file names.
            if (instance.auth && !entry.account) throw new Error(`Site ${entry.id}: a site with auth needs an "account" in the sites file`);
            loaded.push({ id: entry.id, plugin, entry, instance });
        }
    } catch (error) {
        // Nothing gets the instances made so far: stop what they hold (timers, sockets), so
        // the failed process can exit instead of hanging.
        await Promise.allSettled(created.map(async (instance) => { await instance.close?.(); }));
        throw error;
    }
    return loaded;
}

export function sitesWith<K extends keyof SiteInstance>(sites: LoadedSite[], capability: K):
    Array<LoadedSite & { instance: SiteInstance & Required<Pick<SiteInstance, K>> }> {
    return sites.filter((site) => site.instance[capability] !== undefined) as any;
}
