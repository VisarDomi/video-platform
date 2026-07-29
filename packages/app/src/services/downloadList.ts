import { LIST_API, type Provider } from '../constants.js';

export type MembershipState =
	| { state: 'loading' }
	| { state: 'ready'; isMember: boolean }
	| { state: 'adding'; confirmedMember: false }
	| { state: 'removing'; confirmedMember: true }
	| { state: 'error'; confirmedMember: boolean; message: string };

export async function fetchMembership(provider: Provider): Promise<Set<string>> {
	const response = await fetch(LIST_API[provider].list);
	if (!response.ok) throw new Error(`Download-list fetch failed: ${response.status}`);
	const identifiers = (await response.json()) as unknown;
	return new Set(Array.isArray(identifiers) ? identifiers.filter(isString) : []);
}

export async function changeMembership(
	provider: Provider,
	identifier: string,
	add: boolean
): Promise<void> {
	const endpoint = add ? LIST_API[provider].add : LIST_API[provider].remove;
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier })
	});
	if (!response.ok) throw new Error(`Download-list update failed: ${response.status}`);
	const result = (await response.json()) as { success?: boolean };
	if (result.success !== true) throw new Error('Download-list update was not confirmed');
}

export function extractIdentifier(filename: string): string {
	const parts = filename.split(' ');
	return parts.length >= 3 ? parts.slice(2).join(' ') : filename;
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}
