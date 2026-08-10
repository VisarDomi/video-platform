import type { AliasSnapshot } from "../aliasRegistry.js";

export function extractAliasSnapshot(basicProfile: unknown): AliasSnapshot | null {
    if (!basicProfile || typeof basicProfile !== "object") return null;

    const rawAliases = (basicProfile as { aliases?: unknown }).aliases;
    if (!Array.isArray(rawAliases)) return null;

    const aliases: string[] = [];
    const seen = new Set<string>();
    for (const entry of rawAliases) {
        const alias = entry && typeof entry === "object"
            ? (entry as { alias?: unknown }).alias
            : null;
        if (typeof alias !== "string") continue;
        const trimmed = alias.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        aliases.push(trimmed);
    }

    const [current, ...history] = aliases;
    return current ? { current, history } : null;
}
