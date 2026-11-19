import type { AliasHistory, AliasRefresh, Catalog, Target } from "sdk";
import type { Fmp4Api } from "./api.js";
import type { Fmp4Config } from "./config.js";

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
// The list follows renames this often (the core runs the refresh and rewrites the list).
export const NAME_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// One channel per line: "<name> <numeric id>", where the name may also be the
// channel's page URL ("<site>/<name> <id>"). The ID is the target; the name is the
// label. A bare name stays listed but is never looked up until it is added through the
// server, which resolves its ID. A new name for an ID logs as one removed and one added
// entry; on the server, the list follows renames hourly (one bulk status read per 100
// channels gives every current name).
export class Fmp4Catalog implements Catalog {
    public readonly listHeader = "# One channel per line: <name> <channel id> (add through the server to resolve the id)";
    public readonly listChangesBy = "entry" as const;
    public readonly refreshAliases: AliasRefresh;

    constructor(
        private readonly api: Pick<Fmp4Api, "stream" | "byName" | "statuses">,
        private readonly config: Fmp4Config,
    ) {
        this.refreshAliases = { intervalMs: NAME_REFRESH_INTERVAL_MS, run: (ids) => this.currentNames(ids) };
    }

    public parseTargetLine(line: string, warn?: (message: string) => void): Target | null {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return null;
        const [first, second, ...rest] = trimmed.split(/\s+/);
        const name = nameOf(first);
        if (!name || rest.length > 0 || (second !== undefined && !/^\d+$/.test(second))) {
            warn?.(`Could not parse "<name> <channel id>" from line: "${trimmed}"`);
            return null;
        }
        if (second === undefined) warn?.(`Entry "${name}" has no channel id; add it through the server to resolve it`);
        return { id: second ?? "", label: name };
    }

    public formatTargetLine(target: Target): string {
        return target.id ? `${target.label} ${target.id}` : target.label;
    }

    // A channel ID, a name (old names too) or a page URL, checked with the site: the
    // channel's ID and current name; null when the site has no such channel. Throws when
    // the site cannot say.
    public async resolveIdentifier(input: string): Promise<Target | null> {
        const value = input.trim();
        if (/^\d+$/.test(value)) {
            const stream = await this.api.stream(value);
            return stream ? { id: stream.channelId, label: stream.name } : null;
        }
        const name = nameOf(value);
        if (!name) return null;
        const found = await this.api.byName(name);
        return found ? { id: found.id, label: found.name } : null;
    }

    public async exists(identifier: string): Promise<boolean> {
        return (await this.resolveIdentifier(identifier)) !== null;
    }

    // A channel ID is the key itself; a name (an old one too) is the listed channel the
    // site says it belongs to, else the name (an entry without an ID is keyed by it).
    public async resolveForRemove(identifier: string, listed: readonly Target[]): Promise<string> {
        const value = identifier.trim();
        if (/^\d+$/.test(value)) return value;
        const name = nameOf(value) ?? value;
        const byLabel = listed.find((target) => target.label === name && target.id !== "");
        if (byLabel) return byLabel.id;
        const found = await this.api.byName(name).catch(() => null);
        return found && listed.some((target) => target.id === found.id) ? found.id : name;
    }

    // The site's pages are by the current name; there is no page by ID.
    public sourceLinks(target: Target): { channelUrl: string; aliasUrl: string | null } {
        return { channelUrl: `${this.config.baseUrl}/${encodeURIComponent(target.label)}`, aliasUrl: null };
    }

    // The current name of every channel the site could report; the rest are left out
    // (an unavailable status check, logged by the API, leaves the list as it is).
    private async currentNames(ids: string[]): Promise<Map<string, AliasHistory>> {
        const statuses = await this.api.statuses([...new Set(ids)]);
        if (!statuses) return new Map();
        return new Map([...statuses.values()].map((status) => [status.id, { current: status.name, history: [] }]));
    }
}

// A bare name, or the last path segment of a page URL.
function nameOf(value: string): string | null {
    let name = value;
    if (/^https?:\/\//.test(value)) {
        try {
            name = decodeURIComponent(new URL(value).pathname.split("/").filter(Boolean).at(-1) ?? "");
        } catch {
            return null;
        }
    }
    return NAME.test(name) ? name : null;
}
