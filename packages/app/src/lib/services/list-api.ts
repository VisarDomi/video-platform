import { TANGO_LIST_API, FC2_API, SC_API } from '../constants.js';

const apiMap = {
	tango: TANGO_LIST_API,
	fc2: FC2_API,
	sc: SC_API
} as const;

type ListProvider = keyof typeof apiMap;

export function isListProvider(provider: string): provider is ListProvider {
	return provider in apiMap;
}

export async function fetchListIdentifiers(provider: ListProvider): Promise<string[]> {
	try {
		const response = await fetch(apiMap[provider].LIST);
		if (!response.ok) return [];
		return await response.json();
	} catch {
		return [];
	}
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
	// Filenames are like "2025-02-12 143000 Username" — identifier is the last segment
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
