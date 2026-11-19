import type { Catalog, Target } from "sdk";
import type { LadderApi } from "./api.js";
import type { LadderConfig } from "./config.js";

// One channel per line: its numeric ID, optionally followed by a name ("1001
// centre-court"), or its page URL ("<site>/1001"). The ID is the target; the name, or
// else the ID, is the label that names the recording folders.
export class LadderCatalog implements Catalog {
    public readonly listHeader = "# One channel per line: <channel id> [name]";

    constructor(
        private readonly api: Pick<LadderApi, "member">,
        private readonly config: LadderConfig,
    ) {}

    public parseTargetLine(line: string, warn?: (message: string) => void): Target | null {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return null;
        const [first, ...rest] = trimmed.split(/\s+/);
        const id = channelIdOf(first);
        if (!id) {
            warn?.(`Could not parse a channel ID from line: "${trimmed}"`);
            return null;
        }
        const name = rest.join(" ");
        return { id, label: name || id };
    }

    public formatTargetLine(target: Target): string {
        return target.label && target.label !== target.id ? `${target.id} ${target.label}` : target.id;
    }

    // An ID or a channel page URL, checked with the site; null when it has no such
    // channel. Throws when the site cannot say.
    public async resolveIdentifier(input: string): Promise<Target | null> {
        const id = channelIdOf(input.trim());
        if (!id) return null;
        const profile = await this.api.member(id);
        return profile ? { id: profile.id, label: profile.name } : null;
    }

    public async exists(identifier: string): Promise<boolean> {
        return (await this.resolveIdentifier(identifier)) !== null;
    }

    // An ID or a page URL is the key itself; a name is the listed channel it labels.
    public resolveForRemove(identifier: string, listed: readonly Target[]): string {
        const value = identifier.trim();
        return channelIdOf(value) ?? listed.find((target) => target.label === value)?.id ?? value;
    }

    // Channel pages are by ID; the site has no page under a name.
    public sourceLinks(target: Target): { channelUrl: string; aliasUrl: string | null } {
        return { channelUrl: `${this.config.baseUrl}/${target.id}`, aliasUrl: null };
    }
}

// Digits, or the last path segment of a URL when it is digits.
function channelIdOf(value: string): string | null {
    if (/^\d+$/.test(value)) return value;
    if (!/^https?:\/\//.test(value)) return null;
    try {
        const last = new URL(value).pathname.split("/").filter(Boolean).at(-1) ?? "";
        return /^\d+$/.test(last) ? last : null;
    } catch {
        return null;
    }
}
