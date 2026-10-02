import { LIST_API, PC_SERVER, type Provider } from '../constants.js';
import { getProvider } from '../providers/index.js';
import type { Video } from '../types.js';

export type MembershipState =
	| { state: 'loading' }
	| { state: 'ready'; isMember: boolean }
	| { state: 'adding'; confirmedMember: false }
	| { state: 'removing'; confirmedMember: true }
	| { state: 'unavailable'; message: string }
	| { state: 'error'; confirmedMember: boolean; message: string };

export async function fetchMembership(provider: Provider): Promise<Set<string>> {
	const response = await fetch(listUrl(provider, 'list'));
	if (!response.ok) throw new Error(`Download-list fetch failed: ${response.status}`);
	const identifiers = (await response.json()) as unknown;
	if (!Array.isArray(identifiers) || !identifiers.every(isString)) {
		throw new Error('Download-list response is not a string array');
	}
	return new Set(identifiers);
}

export async function changeMembership(
	provider: Provider,
	identifier: string,
	add: boolean
): Promise<void> {
	const response = await fetch(listUrl(provider, add ? 'add' : 'remove'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier })
	});
	if (!response.ok) throw new Error(`Download-list update failed: ${response.status}`);
	const result = (await response.json()) as { success?: boolean };
	if (result.success !== true) throw new Error('Download-list update was not confirmed');
}

// Local pages use their own site's list; live pages (on the provider's site) use the PC's.
function listUrl(provider: Provider, action: 'list' | 'add' | 'remove'): string {
	const source = getProvider(provider);
	if (source.kind === 'local') return LIST_API[source.id][action];
	if (source.live) return PC_SERVER + LIST_API[source.live.downloadList][action];
	throw new Error('This provider has no download list.');
}

// Recordings are listed by the streamer in their filename; live videos are streamers.
export function listIdentifier(video: Video): string {
	return getProvider(video.provider).kind === 'local' ? extractIdentifier(video.filename) : video.filename;
}

export function extractIdentifier(filename: string): string {
	const parts = filename.split(' ');
	return parts.length >= 3 ? parts.slice(2).join(' ') : filename;
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}
