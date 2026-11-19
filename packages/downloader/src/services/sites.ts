import path from "node:path";
import {
    FilePluginStore,
    loadSites,
    readSitesFile,
    type Catalog,
    type LiveCapture,
    type Logger,
    type PluginContext,
    type SiteEntry,
} from "sdk";
import { downloadListPath, servicesDataRoot } from "shared";
import { siteLogger } from "../common/siteLogger.js";

// The sites this deployment captures, from the sites file: $VIDEO_SITES_FILE, else
// <services data root>/sites.json. A missing or invalid file is fatal: running with no
// sites would silently stop every capture.
export function sitesFilePath(): string {
    return process.env.VIDEO_SITES_FILE ?? path.join(servicesDataRoot, "sites.json");
}

export interface CaptureSite {
    id: string;
    label: string;
    log: Logger;
    capture: LiveCapture;
    catalog: Catalog;
    downloadList: string;
    // Stops the timers and connections the site's instance holds.
    close(): Promise<void>;
}

export function siteContext(entry: SiteEntry): PluginContext {
    const stateDir = path.join(servicesDataRoot, "site-state", entry.id);
    return {
        siteId: entry.id,
        config: entry.config ?? {},
        store: new FilePluginStore(stateDir),
        paths: { stateDir, downloadList: downloadListPath(entry.id) },
        log: siteLogger(entry.label ?? entry.id),
        clock: { now: () => Date.now() },
    };
}

export async function loadCaptureSites(
    filePath = sitesFilePath(),
    importPlugin: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<CaptureSite[]> {
    const contexts = new Map<string, PluginContext>();
    const loaded = await loadSites(await readSitesFile(filePath), {
        importPlugin,
        context: (entry) => {
            const context = siteContext(entry);
            contexts.set(entry.id, context);
            return context;
        },
    });
    const sites: CaptureSite[] = [];
    for (const site of loaded) {
        const { capture, catalog } = site.instance;
        if (!capture) continue;
        if (!catalog) throw new Error(`Site ${site.id}: live capture needs a catalog to read its download list`);
        // The provider's name names the recording folders, so it must be the site ID.
        if (capture.provider.providerName !== site.id) {
            throw new Error(`Site ${site.id}: its capture provider is named ${JSON.stringify(capture.provider.providerName)}`);
        }
        const context = contexts.get(site.id)!;
        sites.push({
            id: site.id,
            label: site.entry.label ?? site.id,
            log: context.log,
            capture,
            catalog,
            downloadList: context.paths.downloadList,
            close: async () => { await site.instance.close?.(); },
        });
    }
    if (sites.length === 0) throw new Error(`${filePath}: no site with live capture`);
    return sites;
}
