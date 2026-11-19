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
