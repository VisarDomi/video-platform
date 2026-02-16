import { TANGO_LIST_API } from '../constants.js';

const apiMap = {
	tango: TANGO_LIST_API
} as const;

type ListProvider = keyof typeof apiMap;

export function isListProvider(provider: string): provider is ListProvider {
	return provider in apiMap;
}

export async function fetchListIdentifiers(provider: ListProvider): Promise<string[]> {
	try {
		const response = await fetch(apiMap[provider].FOLLOWING);
		if (!response.ok) return [];
		return await response.json();
	} catch {
		return [];
	}
}

export async function addToList(provider: ListProvider, identifier: string): Promise<boolean> {
	try {
		const response = await fetch(apiMap[provider].FOLLOW, {
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

export async function removeFromList(provider: ListProvider, identifier: string): Promise<boolean> {
	try {
		const response = await fetch(apiMap[provider].UNFOLLOW, {
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
