import type { Target } from "../plugin.js";

// Every name a listed target answers to, for clients that match names: its ID, its label
// and its former names, trimmed, without blanks or repeats, in that order.
export function targetMembershipIdentifiers(target: Target, aliasHistory: readonly string[] = []): string[] {
    return [...new Set([target.id, target.label, ...aliasHistory].map((value) => value.trim()).filter(Boolean))];
}
