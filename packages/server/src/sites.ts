import { readFile } from "node:fs/promises";
import { loadDestinationPlugin, parseDestinations, type DestinationPlugin, type LoadedSite } from "sdk";
import { createLogger, loadSiteRegistry, sitesFilePath, type HostedSite, type ServiceLogger } from "shared";
import logger from "./core/logger.js";
import { registry } from "./services/aliasRefreshService.js";

// The sign-in code that runs in the server (a device's sign-in, /api/<site>/phone-session)
// logs as the auth service, "[auth] ...", as it did when the server imported the auth
// daemon's modules. Made on its first line, as that import was made on the first sign-in.
let authService: ServiceLogger | undefined;
const authLogger = Object.fromEntries((["debug", "verbose", "info", "warn", "error"] as const).map((level) =>
    [level, (message: string, ...meta: any[]) => (authService ??= createLogger("auth"))[level](message, ...meta)])) as ServiceLogger;

// The sites this deployment runs, from the sites file ($VIDEO_SITES_FILE, else
// <services data root>/sites.json; missing or invalid is fatal). Each site logs through
// the server's logger as "[<label>] ..." and its catalog sees the alias registry.
export async function loadServerSites(
    filePath = sitesFilePath(),
    importPlugin?: (specifier: string) => Promise<unknown>,
): Promise<HostedSite[]> {
    return loadSiteRegistry({ logger, authLogger, aliases: registry }, filePath, importPlugin);
}

// The destinations configured in the sites file, for read-only companion endpoints
// (such as sharing a single-session destination's cookies with the phone app).
export async function loadServerDestinations(
    filePath = sitesFilePath(),
    importPlugin?: (specifier: string) => Promise<unknown>,
): Promise<Array<{ id: string; config: Readonly<Record<string, unknown>>; plugin: DestinationPlugin }>> {
    const entries = parseDestinations(await readFile(filePath, "utf8"), filePath);
    const loaded: Array<{ id: string; config: Readonly<Record<string, unknown>>; plugin: DestinationPlugin }> = [];
    for (const entry of entries) {
        const plugin = await loadDestinationPlugin(entry, importPlugin);
        loaded.push({ id: entry.id, config: entry.config ?? {}, plugin });
    }
    return loaded;
}

// The sites whose recordings the server serves (folders <downloads root>/<site>/): the
// capture sites, in the sites file's order.
export function captureSiteIds(sites: readonly LoadedSite[]): string[] {
    return sites.filter((site) => site.instance.capture).map((site) => site.id);
}
