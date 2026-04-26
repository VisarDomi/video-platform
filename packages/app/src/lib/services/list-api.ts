import { TANGO_LIST_API, FC2_API, SC_API } from '../constants.js';

const apiMap = {
	tango: TANGO_LIST_API,
	fc2: FC2_API,
	sc: SC_API
} as const;

type ListProvider = keyof typeof apiMap;

interface ParsedListEntry {
	id: string;
	label: string;
}

export interface ListMetadata {
	identifiers: string[];
	identityGroups: string[][];
}

export function isListProvider(provider: string): provider is ListProvider {
	return provider in apiMap;
}

export async function fetchListIdentifiers(provider: ListProvider): Promise<string[]> {
	const metadata = await fetchListMetadata(provider);
	return metadata.identifiers;
}

export async function fetchListMetadata(provider: ListProvider): Promise<ListMetadata> {
	try {
		const [listResponse, rawResponse] = await Promise.all([
			fetch(apiMap[provider].LIST),
			fetch(apiMap[provider].LIST.replace(/\/list$/, ''))
		]);
		const identifiers = listResponse.ok ? await listResponse.json() : [];
		const raw = rawResponse.ok ? await rawResponse.text() : '';
		return {
			identifiers: Array.isArray(identifiers) ? identifiers : [],
			identityGroups: buildIdentityGroups(
				provider,
				raw,
				Array.isArray(identifiers) ? identifiers : []
			)
		};
	} catch {
		return { identifiers: [], identityGroups: [] };
	}
}

function buildIdentityGroups(
	provider: ListProvider,
	raw: string,
	identifiers: string[]
): string[][] {
	const entries = parseEntries(provider, raw);
	if (entries.length === 0) return [];
	if (provider === 'tango') return buildTangoGroups(entries, identifiers);
	return entries
		.map((entry) =>
			[entry.id, entry.label].filter((value, index, all) => value && all.indexOf(value) === index)
		)
		.filter((group) => group.length > 1);
}

function parseEntries(provider: ListProvider, raw: string): ParsedListEntry[] {
	return raw
		.split('\n')
		.map((line) => parseEntry(provider, line))
		.filter((entry): entry is ParsedListEntry => entry !== null);
}

function parseEntry(provider: ListProvider, line: string): ParsedListEntry | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith('#')) return null;
	if (provider === 'tango') {
		const prefix = 'https://tango.me/';
		if (!trimmed.startsWith(prefix)) return null;
		const rest = trimmed.slice(prefix.length);
		const spaceIdx = rest.indexOf(' ');
		if (spaceIdx === -1) return null;
		return { id: rest.slice(0, spaceIdx), label: rest.slice(spaceIdx + 1) };
	}
	if (provider === 'sc') {
		const prefix = 'https://stripchat.com/';
		if (!trimmed.startsWith(prefix)) return null;
		const rest = trimmed.slice(prefix.length).replace(/\/$/, '');
		const spaceIdx = rest.indexOf(' ');
		if (spaceIdx === -1) return { id: rest, label: rest };
		return { id: rest.slice(spaceIdx + 1), label: rest.slice(0, spaceIdx) };
	}
	const prefix = 'https://live.fc2.com/';
	if (!trimmed.startsWith(prefix)) return null;
	const id = trimmed.slice(prefix.length).replace(/\/$/, '');
	return { id, label: id };
}

function buildTangoGroups(entries: ParsedListEntry[], identifiers: string[]): string[][] {
	const ids = new Set(entries.map((entry) => entry.id));
	const groups = new Map<string, string[]>();
	let currentId: string | null = null;

	for (const identifier of identifiers) {
		if (ids.has(identifier)) {
			currentId = identifier;
			if (!groups.has(currentId)) groups.set(currentId, [identifier]);
			continue;
		}
		if (currentId) groups.get(currentId)?.push(identifier);
	}

	for (const entry of entries) {
		const group = groups.get(entry.id) || [entry.id];
		group.push(entry.label);
		groups.set(entry.id, group);
	}

	return [...groups.values()]
		.map((group) => [...new Set(group.filter(Boolean))])
		.filter((group) => group.length > 1);
}

export async function addToList(provider: ListProvider, identifier: string): Promise<boolean> {
	try {
		const response = await fetch(apiMap[provider].ADD, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifier })
		});
		const data = await response.json();
		return data.success;
	} catch {
		return false;
	}
}

export function extractIdentifier(filename: string): string {
	const parts = filename.split(' ');
	return parts.length >= 3 ? parts.slice(2).join(' ') : filename;
}

export async function removeFromList(provider: ListProvider, identifier: string): Promise<boolean> {
	try {
		const response = await fetch(apiMap[provider].REMOVE, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifier })
		});
		const data = await response.json();
		return data.success;
	} catch {
		return false;
	}
}
