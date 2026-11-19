import path from "node:path";
import {
    FilePluginStore,
    loadSites,
    readSitesFile,
    type AliasBook,
    type LoadedSite,
    type Logger,
    type PluginContext,
    type SiteEntry,
    type SitePlugin,
} from "sdk";
import { downloadListPath, servicesDataRoot } from "./providerLayout.js";
import { CredentialStore, servicesHome, servicesStateHome } from "./credentialStore.js";

// The plumbing every service shares to run the sites of a deployment: the sites file,
// each site's context (logger, store, paths) and the loading of their plug-ins.

// The sites this deployment runs: $VIDEO_SITES_FILE, else <services data root>/sites.json.
// A missing or invalid file is fatal for every service that reads it.
export function sitesFilePath(): string {
    return process.env.VIDEO_SITES_FILE ?? path.join(servicesDataRoot, "sites.json");
}

// The levels of a service's own logger (createLogger).
type Level = "debug" | "verbose" | "info" | "warn" | "error";
export type ServiceLogger = Record<Level, (message: string, ...meta: any[]) => unknown>;

// A logger whose lines are "[<tag>] <message>" on the service's logger. Monitoring reads
// these lines, so the tags and the messages are part of the contract. The service logger
// is looked up on every call, so a test can observe it.
export function taggedLogger(base: ServiceLogger, tag?: string): Logger {
    const prefix = tag === undefined ? "" : `[${tag}] `;
    const line = (level: Level) => (message: string, meta?: Record<string, unknown>) => {
        if (meta === undefined) base[level](prefix + message);
        else base[level](prefix + message, meta);
    };
    return {
        debug: line("debug"),
        verbose: line("verbose"),
        info: line("info"),
        warn: line("warn"),
        error: line("error"),
        tagged: (other?: string) => taggedLogger(base, other),
    };
}

export interface SiteHost {
    // The service's logger; a site logs through it as "[<plug-in label>] ...".
    logger: ServiceLogger;
    // The service's alias registry, if it keeps one.
    aliases?: AliasBook;
    // Where the sites' credentials are read from; default: the services' session folder.
    credentials?: CredentialStore;
}

export function siteContext(entry: SiteEntry, plugin: SitePlugin, host: SiteHost): PluginContext {
    // The label is the monitored log prefix; a plug-in without one cannot start.
    if (typeof plugin.label !== "string" || plugin.label.trim() === "") {
        throw new Error(`Site ${entry.id}: ${entry.plugin} has no label`);
    }
    const stateDir = path.join(servicesDataRoot, "site-state", entry.id);
    return {
        siteId: entry.id,
        config: entry.config ?? {},
        store: new FilePluginStore(stateDir),
        paths: {
            stateDir,
            downloadList: downloadListPath(entry.id),
            // Home-relative like the session files, named after the site (pinned: existing
            // profiles and login state live at these names).
            browserProfiles: path.join(servicesHome(), `${entry.id}-browser-profiles`),
            loginState: path.join(servicesStateHome(), `${entry.id}-login`),
        },
        log: taggedLogger(host.logger, plugin.label),
        clock: { now: () => Date.now() },
        ...(host.aliases ? { aliases: host.aliases } : {}),
        credentials: (host.credentials ?? new CredentialStore()).source(entry.account),
    };
}

export interface HostedSite extends LoadedSite {
    // The plug-in's label: the prefix of the site's log lines.
    label: string;
    context: PluginContext;
}

// Loads the plug-in of every enabled site in the sites file and creates its instance, in
// the file's order. Creating an instance starts nothing; a host runs what it needs.
export async function loadSiteRegistry(
    host: SiteHost,
    filePath = sitesFilePath(),
    importPlugin: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<HostedSite[]> {
    const contexts = new Map<string, PluginContext>();
    const loaded = await loadSites(await readSitesFile(filePath), {
        importPlugin,
        context: (entry, plugin) => {
            const context = siteContext(entry, plugin, host);
            contexts.set(entry.id, context);
            return context;
        },
    });
    return loaded.map((site) => ({ ...site, label: site.plugin.label, context: contexts.get(site.id)! }));
}

// Stops what the instances hold (timers, sockets), so a short-lived command can exit.
export async function closeSites(sites: readonly LoadedSite[]): Promise<void> {
    await Promise.allSettled(sites.map(async (site) => { await site.instance.close?.(); }));
}
