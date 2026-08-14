export type StreamProvider = "tango" | "fc2" | "sc";

export interface StreamerTarget {
    readonly provider: StreamProvider;
    readonly id: string;
    readonly label: string;
}

export interface StreamerSourceLinks {
    readonly streamerUrl: string;
    readonly aliasUrl: string | null;
}

const PREFIXES: Readonly<Record<StreamProvider, string>> = {
    tango: "https://tango.me/",
    fc2: "https://live.fc2.com/",
    sc: "https://stripchat.com/",
};

export function parseStreamerTargetLine(provider: StreamProvider, rawLine: string): StreamerTarget | null {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return null;
    const prefix = PREFIXES[provider];
    if (!line.startsWith(prefix)) return null;
    const rest = line.slice(prefix.length).trim();
    if (!rest) return null;

    if (provider === "fc2") {
        const id = rest.replace(/\/$/, "");
        return /^\d+$/.test(id) ? { provider, id, label: id } : null;
    }

    const spaceIndex = rest.indexOf(" ");
    if (provider === "sc" && spaceIndex === -1) {
        const label = rest.replace(/\/$/, "");
        return label ? { provider, id: label, label } : null;
    }
    if (spaceIndex < 1) return null;
    const first = rest.slice(0, spaceIndex).replace(/\/$/, "").trim();
    const second = rest.slice(spaceIndex + 1).trim();
    if (!first || !second) return null;
    return provider === "tango"
        ? { provider, id: first, label: second }
        : /^\d+$/.test(second) ? { provider, id: second, label: first } : null;
}

export function formatStreamerTarget(target: StreamerTarget): string {
    const prefix = PREFIXES[target.provider];
    switch (target.provider) {
        case "tango": return `${prefix}${target.id} ${target.label}`;
        case "fc2": return `${prefix}${target.id}/`;
        case "sc": return `${prefix}${target.label} ${target.id}`;
    }
}

export function streamerSourceLinks(target: StreamerTarget): StreamerSourceLinks {
    const prefix = PREFIXES[target.provider];
    if (target.provider === "fc2") {
        return { streamerUrl: `${prefix}${target.id}/`, aliasUrl: null };
    }
    return {
        streamerUrl: `${prefix}${target.id}`,
        aliasUrl: target.label === target.id ? null : `${prefix}${target.label}`,
    };
}

export function targetMembershipIdentifiers(
    target: StreamerTarget,
    aliasHistory: readonly string[] = [],
): string[] {
    return [...new Set([target.id, target.label, ...aliasHistory].map((value) => value.trim()).filter(Boolean))];
}

export function extractRecordingIdentifier(filename: string): string {
    const parts = filename.trim().split(/\s+/);
    return parts.length >= 3 ? parts.slice(2).join(" ") : filename.trim();
}
