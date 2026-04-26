import type { Video } from '../types.js';
import { extractAlias } from './alias.js';

export interface AliasFilterGroup {
	readonly id: string;
	readonly aliases: readonly string[];
	readonly count: number;
	readonly label: string;
}

class DisjointSet {
	private readonly parent = new Map<string, string>();

	add(value: string) {
		if (!this.parent.has(value)) this.parent.set(value, value);
	}

	find(value: string): string {
		const parent = this.parent.get(value);
		if (!parent) {
			this.parent.set(value, value);
			return value;
		}
		if (parent === value) return value;
		const root = this.find(parent);
		this.parent.set(value, root);
		return root;
	}

	union(a: string, b: string) {
		const rootA = this.find(a);
		const rootB = this.find(b);
		if (rootA !== rootB) this.parent.set(rootB, rootA);
	}
}

export function getAliasCounts(videos: Video[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const video of videos) {
		const alias = extractAlias(video.filename);
		if (!alias) continue;
		counts.set(alias, (counts.get(alias) || 0) + 1);
	}
	return counts;
}

function unionGroup(dsu: DisjointSet, aliases: readonly string[], present: Set<string>) {
	const filtered = aliases.filter((alias) => present.has(alias));
	if (filtered.length < 2) return;
	const [first, ...rest] = filtered;
	for (const alias of rest) dsu.union(first, alias);
}

export function buildAliasFilterGroups(
	videos: Video[],
	identityGroups: readonly (readonly string[])[],
	manualGroups: readonly (readonly string[])[]
): AliasFilterGroup[] {
	const counts = getAliasCounts(videos);
	const present = new Set(counts.keys());
	const dsu = new DisjointSet();

	for (const alias of present) dsu.add(alias);
	for (const group of identityGroups) unionGroup(dsu, group, present);
	for (const group of manualGroups) unionGroup(dsu, group, present);

	const components = new Map<string, string[]>();
	for (const alias of present) {
		const root = dsu.find(alias);
		const group = components.get(root) || [];
		group.push(alias);
		components.set(root, group);
	}

	return [...components.values()]
		.map((aliases) => {
			aliases.sort((a, b) => a.localeCompare(b));
			const label = [...aliases].sort((a, b) => {
				const byCount = (counts.get(b) || 0) - (counts.get(a) || 0);
				return byCount || a.localeCompare(b);
			})[0];
			return {
				id: aliases.join('\u001f'),
				aliases,
				count: aliases.reduce((sum, alias) => sum + (counts.get(alias) || 0), 0),
				label
			};
		})
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function expandSelectedAliases(
	selectedAliases: ReadonlySet<string>,
	groups: readonly AliasFilterGroup[]
): Set<string> {
	if (selectedAliases.size === 0) return new Set();
	const expanded = new Set<string>();
	for (const group of groups) {
		if (group.aliases.some((alias) => selectedAliases.has(alias))) {
			for (const alias of group.aliases) expanded.add(alias);
		}
	}
	return expanded;
}
