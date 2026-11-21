import { createHash } from "node:crypto";
import { SDK_VERSION, type FileHost, type FileHostContext, type FileHostHttp, type FileHostPlugin, type ResolvedFile } from "sdk";

// The simulated file host: file pages /f/<id> with a download button that names the
// file, and a link API that signs a short-lived URL on its download host. The core's
// queue does the transfer (resume with proof, publication, the library); this plug-in
// only knows the pages. Where the host runs comes from the sites file:
//
//   { "fileHosts": [ { "id": "file-host", "plugin": "plugin-file-host", "allowPorts": [18084, 18085],
//       "config": { "origin": "https://127.0.0.1:18084", "downloadHosts": ["127.0.0.1"],
//                   "directory": "~/Videos/file-host" } } ] }
//
// "allowPorts" belongs to the core: it lets the core reach a host that is not on 443.

export interface FileHostConfig {
    // The site's origin: file pages and the link API.
    origin: URL;
    // The host names the signed download URLs may point at (the site's own host always may).
    downloadHosts: ReadonlySet<string>;
}

// A file's ID as the site writes it.
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function readConfig(raw: Readonly<Record<string, unknown>>): FileHostConfig {
    let origin: URL;
    try {
        origin = new URL(String(raw.origin));
    } catch {
        throw new Error("config.origin must be the file host's https origin");
    }
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
        throw new Error("config.origin must be the file host's https origin");
    }
    const hosts = raw.downloadHosts ?? [];
    if (!Array.isArray(hosts) || !hosts.every((host) => typeof host === "string" && /^[A-Za-z0-9.-]{1,253}$/.test(host))) {
        throw new Error("config.downloadHosts must be a list of host names");
    }
    return { origin, downloadHosts: new Set([origin.hostname, ...hosts.map((host: string) => host.toLowerCase())]) };
}

// The canonical file page (no query, fragment or trailing slash), or null when the URL is
// not one of this host's file pages.
export function filePage(config: FileHostConfig, value: string): string | null {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (url.origin !== config.origin.origin || url.username || url.password) return null;
    const id = url.pathname.match(/^\/f\/([^/]+)\/?$/)?.[1];
    if (!id || !FILE_ID.test(decodeURIComponent(id))) return null;
    return `${config.origin.origin}/f/${id}`;
}

// The job key the browser extension computes too: the first 24 hex digits of the
// SHA-256 of the page's path.
export function jobKey(page: string): string {
    return createHash("sha256").update(new URL(page).pathname).digest("hex").slice(0, 24);
}

// The page names the file (its download button); the link API signs the URL, and wants
// the page as its referer.
export async function resolve(config: FileHostConfig, page: string, http: FileHostHttp): Promise<ResolvedFile> {
    const canonical = filePage(config, page);
    if (!canonical) throw new Error("Expected a file page of this host");
    const html = await http.text(canonical);
    const id = html.match(/<a[^>]*\bid="download"[^>]*\bdata-file-id="([^"]+)"/)?.[1]
        ?? html.match(/<a[^>]*\bdata-file-id="([^"]+)"[^>]*\bid="download"/)?.[1];
    if (!id || !FILE_ID.test(id)) throw new Error("The file page has no download button");
    const answer = await http.text(`${config.origin.origin}/api/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Referer: canonical },
        body: JSON.stringify({ id }),
    });
    let link: { url?: unknown; name?: unknown };
    try { link = JSON.parse(answer); } catch { throw new Error("The link API answered something other than JSON"); }
    if (typeof link.url !== "string" || typeof link.name !== "string" || !link.name) throw new Error("The link API answered without a URL and a name");
    return { url: link.url, filename: link.name };
}

export function createFileHost(context: FileHostContext): FileHost {
    const config = readConfig(context.config);
    return {
        canonicalPage: (url) => filePage(config, url),
        isAllowedHost: (url) => config.downloadHosts.has(url.hostname.toLowerCase()),
        resolve: (page, http) => resolve(config, page, http),
        jobKey,
    };
}

export const fileHost: FileHostPlugin = {
    id: "file-host",
    label: "File host",
    sdkVersion: SDK_VERSION,
    createFileHost,
};

export default fileHost;
