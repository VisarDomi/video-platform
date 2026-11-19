import type { LoadedSite } from "sdk";
import { loadSiteRegistry, sitesFilePath, type HostedSite } from "shared";
import logger from "./core/logger.js";
import { registry } from "./services/aliasRefreshService.js";

// The sites this deployment runs, from the sites file ($VIDEO_SITES_FILE, else
// <services data root>/sites.json; missing or invalid is fatal). Each site logs through
// the server's logger as "[<label>] ..." and its catalog sees the alias registry.
export async function loadServerSites(
    filePath = sitesFilePath(),
    importPlugin?: (specifier: string) => Promise<unknown>,
): Promise<HostedSite[]> {
    return loadSiteRegistry({ logger, aliases: registry }, filePath, importPlugin);
}

// The sites whose recordings the server serves (folders <downloads root>/<site>/): the
// capture sites, in the sites file's order.
export function captureSiteIds(sites: readonly LoadedSite[]): string[] {
    return sites.filter((site) => site.instance.capture).map((site) => site.id);
}
