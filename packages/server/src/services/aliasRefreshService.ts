import { promises as fs } from "fs";
import * as path from "path";
import type { AliasRefresh, Catalog, Logger } from "sdk";
import { AliasRegistry } from "./aliasRegistry.js";
import { ALIASES_PATH } from "../core/config.js";
import { mutateTextFile } from "../core/durableFile.js";
import { renameListedTargets } from "./listRenames.js";

// The deployment's alias registry (aliases.json). Catalogs read it through their context;
// the refresh below keeps it current.
export const registry = new AliasRegistry(ALIASES_PATH);

export interface AliasRefreshSite {
    id: string;
    label: string;
    log: Logger;
    listPath: string;
    catalog: Catalog;
}

type RefreshingSite = AliasRefreshSite & { catalog: Catalog & { refreshAliases: AliasRefresh } };

// The IDs of the list's targets, in list order (repeats kept).
function listedIds(catalog: Catalog, content: string): string[] {
    const ids: string[] = [];
    for (const line of content.split("\n")) {
        const id = catalog.parseTargetLine(line)?.id;
        if (id) ids.push(id);
    }
    return ids;
}

async function refreshIds(site: RefreshingSite, listed: string[]): Promise<string[]> {
    const { refreshAliases } = site.catalog;
    return refreshAliases.ids ? refreshAliases.ids(listed) : listed;
}

// A site that keeps no history: its list takes the names one refresh returns. Applied to
// the list's current content, so entries added or removed while the names were being
// fetched are kept as they are.
export async function refreshListNames(site: RefreshingSite, log: Logger = site.log): Promise<void> {
    let content: string;
    try {
        content = await fs.readFile(site.listPath, "utf-8");
    } catch {
        return;
    }
    const listed = listedIds(site.catalog, content);
    if (listed.length === 0) return;

    const names = await site.catalog.refreshAliases.run(await refreshIds(site, listed));
    if (names.size === 0) return;

    // The fetch can take seconds; the +/- routes may have changed the list meanwhile.
    const fileName = path.basename(site.listPath);
    await mutateTextFile(site.listPath, (current) => ({
        next: current === null ? null : renameListedTargets(current, site.catalog, (id) => names.get(id)?.current,
            (target, name) => log.info(`${fileName} sync: ${target.id} ${target.label} -> ${name}`)),
        result: undefined,
    }));
}

// Starts each site's alias refresh: once now, then at the site's interval. Sites that
// keep history refresh the registry (loaded first) and take their names from it; the
// others refresh their list alone, logging as "[<label> Alias Refresh]".
export function startAliasRefresh(sites: readonly AliasRefreshSite[]): void {
    const refreshing = sites.filter((site): site is RefreshingSite => site.catalog.refreshAliases !== undefined);

    const boot = async () => {
        await registry.load();
        for (const site of refreshing.filter((site) => site.catalog.refreshAliases.keepHistory)) {
            const { refreshAliases } = site.catalog;
            registry.startPeriodicRefresh(
                refreshAliases.intervalMs,
                async () => refreshIds(site, listedIds(site.catalog, await fs.readFile(site.listPath, "utf-8").catch(() => ""))),
                (ids) => refreshAliases.run(ids),
                { path: site.listPath, catalog: site.catalog },
            );
        }
    };
    void boot();

    for (const site of refreshing.filter((site) => !site.catalog.refreshAliases.keepHistory)) {
        const log = site.log.tagged?.(`${site.label} Alias Refresh`) ?? site.log;
        const run = async () => {
            try {
                await refreshListNames(site, log);
            } catch (error: any) {
                log.error("Periodic refresh failed", { error: error.message });
            }
        };

        void run();
        setInterval(() => {
            void run();
        }, site.catalog.refreshAliases.intervalMs);
    }
}
