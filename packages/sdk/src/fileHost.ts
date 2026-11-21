import { SDK_VERSION } from "./plugin.js";

// ---- File host ------------------------------------------------------------------------
//
// A site the owner downloads single videos from: a file page is sent from the phone (its
// browser extension), and the PC copies the original file into a local library. The core
// owns everything that must not go wrong: durable jobs, transfers that resume only with
// proof, publication without overwriting, the network guard, the library and its renames.
// A file host plug-in only knows its pages: which URLs are file pages, which hosts serve
// them, and how a page leads to its media.
//
// A deployment lists its file hosts in the sites file; they are not capture sites:
//
//   { "fileHosts": [ { "id": "file-host", "plugin": "plugin-file-host",
//                      "config": { "directory": "~/Videos/file-host" } } ], "sites": [ ... ] }
//
// "config.directory" is where completed files are published (default ~/Videos/<id>); the
// plug-in reads the rest of "config" (createFileHost). The core contacts a host only over
// HTTPS on the default port; "allowPorts" (the entry's, not the config's) names the other
// ports a deployment allows for that host, e.g. a simulated host on 127.0.0.1:18084. Only
// the operator writes it: neither a plug-in nor a page can widen the guard.

// What the core lets a file host fetch while it resolves a page: small answers (at most
// 1 MiB) from its own hosts over HTTPS, redirects followed only to them.
export interface FileHostHttp {
    text(url: string, init?: { readonly method?: "GET" | "POST"; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }): Promise<string>;
}

export interface ResolvedFile {
    // The media itself (on an allowed host).
    readonly url: string;
    // The original file name; the core makes it safe and requires a video container.
    readonly filename: string;
}

export interface FileHost {
    // The page a download is known by (no query, no fragment), or null when the URL is not a
    // file page of this host.
    canonicalPage(url: string): string | null;
    // Whether the core may contact this host for it. Checked on every request and every
    // redirect hop, so neither a page nor its metadata can point the PC at the LAN.
    isAllowedHost(url: URL): boolean;
    // The media behind a canonical page.
    resolve(page: string, http: FileHostHttp): Promise<ResolvedFile>;
    // A job's key: 24 lowercase hex digits, stable for a page. The browser extension
    // computes the same to find a page's job.
    jobKey(page: string): string;
}

export interface FileHostContext {
    // The entry's "config" block from the sites file ({} without one).
    config: Readonly<Record<string, unknown>>;
}

export interface FileHostPlugin {
    // The plug-in type, e.g. "file-host".
    id: string;
    // The host's display name, in messages and log lines.
    label: string;
    sdkVersion: typeof SDK_VERSION;
    // Throws on a config it cannot use: a broken sites file stops the start.
    createFileHost(context: FileHostContext): FileHost;
}

export interface FileHostEntry {
    id: string;
    plugin: string;
    config?: Record<string, unknown>;
    // Ports other than HTTPS's default that the core may contact this host on.
    allowPorts?: number[];
}

const FILE_HOST_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseFileHosts(text: string, source = "sites file"): FileHostEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error: any) {
        throw new Error(`${source}: invalid JSON (${error.message})`);
    }
    const list = (parsed as { fileHosts?: unknown } | null)?.fileHosts;
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new Error(`${source}: fileHosts must be a list`);
    const seen = new Set<string>();
    return list.map((raw, index) => {
        const entry = raw as FileHostEntry;
        const where = `${source}: fileHosts[${index}]`;
        if (typeof entry?.id !== "string" || !FILE_HOST_ID.test(entry.id)) throw new Error(`${where}: invalid id ${JSON.stringify(entry?.id)}`);
        if (seen.has(entry.id)) throw new Error(`${where}: duplicate id ${entry.id}`);
        seen.add(entry.id);
        if (typeof entry.plugin !== "string" || !entry.plugin) throw new Error(`${where}: plugin is required`);
        if (entry.config !== undefined && (typeof entry.config !== "object" || entry.config === null || Array.isArray(entry.config))) {
            throw new Error(`${where}: config must be an object`);
        }
        const ports = entry.allowPorts;
        if (ports !== undefined && (!Array.isArray(ports) || ports.length === 0
            || !ports.every((port) => Number.isInteger(port) && port > 0 && port < 65536 && port !== 443)
            || new Set(ports).size !== ports.length)) {
            throw new Error(`${where}: allowPorts must be a list of distinct ports (1-65535, not 443)`);
        }
        return { id: entry.id, plugin: entry.plugin, ...(entry.config ? { config: entry.config } : {}), ...(ports ? { allowPorts: [...ports] } : {}) };
    });
}

export async function loadFileHostPlugin(
    entry: FileHostEntry,
    importPlugin: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<FileHostPlugin> {
    const module = await importPlugin(entry.plugin) as { default?: unknown; fileHost?: unknown };
    const plugin = (module.fileHost ?? module.default) as FileHostPlugin | undefined;
    if (!plugin || typeof plugin.createFileHost !== "function") {
        throw new Error(`File host ${entry.id}: ${entry.plugin} does not export a file host plug-in`);
    }
    if (plugin.sdkVersion !== SDK_VERSION) {
        throw new Error(`File host ${entry.id}: ${entry.plugin} targets SDK ${plugin.sdkVersion}, this core runs SDK ${SDK_VERSION}`);
    }
    return plugin;
}
