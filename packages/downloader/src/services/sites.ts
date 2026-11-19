import type { Catalog, LiveCapture, Logger } from "sdk";
import { loadSiteRegistry, sitesFilePath } from "shared";
import logger from "../common/logger.js";

// The sites this deployment captures, from the sites file: $VIDEO_SITES_FILE, else
// <services data root>/sites.json. A missing or invalid file is fatal: running with no
// sites would silently stop every capture.
export { sitesFilePath };

export interface CaptureSite {
    id: string;
    // The plug-in's label: the prefix of every log line about the site.
    label: string;
    log: Logger;
    capture: LiveCapture;
    catalog: Catalog;
    downloadList: string;
    // The instance's own start-up work; run after its list has been read.
    init(): Promise<void>;
    // Stops the timers and connections the site's instance holds.
    close(): Promise<void>;
}

// Loads the plug-in of every site in the sites file and creates its instance. Instance
// creation has no start-up side effects to speak of; each instance's init runs later,
// when the host calls CaptureSite.init.
export async function loadCaptureSites(
    filePath = sitesFilePath(),
    importPlugin: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<CaptureSite[]> {
    const loaded = await loadSiteRegistry({ logger }, filePath, importPlugin);
    const sites: CaptureSite[] = [];
    for (const site of loaded) {
        const { capture, catalog } = site.instance;
        if (!capture) continue;
        if (!catalog) throw new Error(`Site ${site.id}: live capture needs a catalog to read its download list`);
        // The provider's name names the recording folders, so it must be the site ID.
        if (capture.provider.providerName !== site.id) {
            throw new Error(`Site ${site.id}: its capture provider is named ${JSON.stringify(capture.provider.providerName)}`);
        }
        const context = site.context;
        sites.push({
            id: site.id,
            label: site.plugin.label,
            log: context.log,
            capture,
            catalog,
            downloadList: context.paths.downloadList,
            init: async () => { await site.instance.init?.(); },
            close: async () => { await site.instance.close?.(); },
        });
    }
    if (sites.length === 0) throw new Error(`${filePath}: no site with live capture`);
    return sites;
}
