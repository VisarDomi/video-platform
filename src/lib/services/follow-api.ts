import { TANGO_API, SC_API, FC2_API } from '../constants.js';

const apiMap = {
	tango: TANGO_API,
	sc: SC_API,
	fc2: FC2_API,
	mp4: TANGO_API
} as const;

type FollowProvider = keyof typeof apiMap;

export function isFollowProvider(provider: string): provider is FollowProvider {
	return provider in apiMap;
}

export async function fetchFollowing(provider: FollowProvider): Promise<string[]> {
	try {
		const response = await fetch(apiMap[provider].FOLLOWING);
		if (!response.ok) return [];
		return await response.json();
	} catch {
		return [];
	}
}

export async function follow(provider: FollowProvider, identifier: string): Promise<boolean> {
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

export async function unfollow(provider: FollowProvider, identifier: string): Promise<boolean> {
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

export function extractIdentifier(filename: string): string {
	// Filenames are like "2025-02-12 143000 Username" — identifier is the last segment
	const parts = filename.split(' ');
	return parts.length >= 3 ? parts.slice(2).join(' ') : filename;
}
