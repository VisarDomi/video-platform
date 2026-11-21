import { targetMembershipIdentifiers, type AliasBook, type AliasHistory, type AliasRefresh, type Catalog, type Target } from "sdk";
import type { Profile, TsLiveApi } from "./api.js";
import type { TsLiveConfig } from "./config.js";

// The list line "<accountId> <name>". Pinned: other programs read the lists, and a line
// that stops parsing ends that account's capture.
const TARGET_LINE = /^([A-Za-z0-9_-]+)\s+(\S.*)$/;

const historyOf = (profile: Profile): AliasHistory => ({ current: profile.names[0], history: profile.names.slice(1).reverse() });

// The download list and identity. Accounts are listed by ID with their current name. On
// the server an account is found by its ID, its page URL or any name it had (the core's
// alias registry first, then the site); adding one follows it on the site, whose
// followings the hourly name refresh also reads.
export class TsLiveCatalog implements Catalog {
    public readonly listHeader = "# One account per line: <accountId> <name>";
    public readonly refreshAliases: AliasRefresh;

    constructor(private readonly api: TsLiveApi, config: TsLiveConfig, private readonly book?: AliasBook) {
        this.refreshAliases = {
            intervalMs: config.aliasRefreshIntervalMs,
            keepHistory: true,
            // The followed accounts too, so a name used before it was listed still resolves.
            ids: async (listed) => [...new Set([...listed, ...((await this.api.followings()) ?? [])])],
            run: async (ids) => {
                const profiles = await this.api.profiles(ids);
                const names = new Map<string, AliasHistory>();
                for (const [key, profile] of profiles ?? []) if (key === profile.accountId) names.set(key, historyOf(profile));
                return names;
            },
        };
    }

    public parseTargetLine(line: string, warn?: (message: string) => void): Target | null {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return null;
        const match = trimmed.match(TARGET_LINE);
        if (!match) {
            warn?.(`Invalid target line (expected "<accountId> <name>"): ${trimmed}`);
            return null;
        }
        return { id: match[1], label: match[2].trim() };
    }

    public formatTargetLine(target: Target): string {
        return `${target.id} ${target.label}`;
    }

    public sourceLinks(target: Target): { channelUrl: string; aliasUrl: string | null } {
        return {
            channelUrl: `${this.api.baseUrl}/${encodeURIComponent(target.id)}`,
            aliasUrl: target.label === target.id ? null : `${this.api.baseUrl}/${encodeURIComponent(target.label)}`,
        };
    }

    // An account ID, the account's page URL, or a name it has or had.
    public async resolveIdentifier(input: string): Promise<Target | null> {
        const key = this.keyOf(input);
        if (!key) return null;
        const known = this.book?.idForName(key) ?? (this.book?.current(key) ? key : null);
        const profiles = await this.api.profiles([known ?? key]);
        const profile = profiles?.get(known ?? key);
        if (!profile) return null;
        await this.book?.record(profile.accountId, historyOf(profile));
        return { id: profile.accountId, label: profile.names[0] };
    }

    public async beforeAdd(target: Target): Promise<void> {
        const following = await this.api.followings();
        if (!following) throw new Error("Could not read the account's followings");
        if (!following.includes(target.id)) await this.api.follow(target.id);
    }

    public async exists(identifier: string): Promise<boolean> {
        const key = this.keyOf(identifier);
        if (!key) return false;
        const profiles = await this.api.profiles([key]);
        if (!profiles) throw new Error("The site could not say whether the account exists");
        return profiles.has(key);
    }

    public enrichList(listed: readonly Target[]): string[] {
        const identifiers = new Set<string>();
        for (const target of listed) {
            for (const identifier of targetMembershipIdentifiers(target, this.book?.names(target.id) ?? [])) identifiers.add(identifier);
        }
        return [...identifiers];
    }

    public async resolveForRemove(identifier: string, listed: readonly Target[]): Promise<string> {
        const key = this.keyOf(identifier) ?? identifier.trim();
        if (listed.some((target) => target.id === key)) return key;
        const known = this.book?.idForName(key);
        if (known) return known;
        const byLabel = listed.find((target) => target.label === key);
        if (byLabel) return byLabel.id;
        // A name the registry never saw: the site still knows current and former names.
        return (await this.api.profiles([key]))?.get(key)?.accountId ?? key;
    }

    // The ID or name in user input: a page URL gives its last path segment.
    private keyOf(input: string): string | null {
        const trimmed = input.trim();
        if (!trimmed) return null;
        if (/^https?:\/\//.test(trimmed)) {
            try {
                const segment = new URL(trimmed).pathname.split("/").filter(Boolean).pop();
                return segment ? decodeURIComponent(segment) : null;
            } catch {
                return null;
            }
        }
        return trimmed;
    }
}
