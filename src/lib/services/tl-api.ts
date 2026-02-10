import { TL_API } from '../constants.js';

export interface TlStreamer {
	streamerId: string;
	streamId: string;
	alias: string;
	firstName: string;
	masterListUrl: string;
	isFollowing: boolean;
	parentAlias?: string;
}

export interface TlStreamsResponse {
	following: TlStreamer[];
	recommended: TlStreamer[];
}

export async function fetchStreams(): Promise<TlStreamsResponse> {
	const response = await fetch(TL_API.STREAMS);
	if (!response.ok) throw new Error(`Failed to fetch streams: ${response.status}`);
	return await response.json();
}

export async function startDownload(streamer: TlStreamer): Promise<void> {
	await fetch(TL_API.DOWNLOAD_START, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			masterPlaylistUrl: streamer.masterListUrl,
			alias: streamer.alias,
			streamerId: streamer.streamerId
		})
	});
}

export async function stopDownload(alias: string): Promise<void> {
	await fetch(TL_API.DOWNLOAD_STOP, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ alias })
	});
}

let previousActiveSet = new Set<string>();

export function sendActiveSet(aliases: string[]) {
	console.log('[TL:dl] active set:', aliases.join(', ') || '(empty)');
	const nextSet = new Set(aliases);

	// Immediately stop downloads that just dropped out of the active window
	for (const alias of previousActiveSet) {
		if (!nextSet.has(alias)) {
			console.log('[TL:dl] immediate stop:', alias);
			void stopDownload(alias);
		}
	}
	previousActiveSet = nextSet;

	// Also update server-side active set (heartbeat + safety net)
	void fetch(TL_API.DOWNLOAD_ACTIVE, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ aliases })
	});
}

export async function fetchLiveFilenames(): Promise<Record<string, string>> {
	try {
		const response = await fetch(TL_API.LIVE_FILENAMES);
		if (!response.ok) return {};
		return await response.json();
	} catch {
		return {};
	}
}

export async function followStreamer(streamerId: string): Promise<boolean> {
	const response = await fetch(TL_API.FOLLOW, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ streamerId })
	});
	const data = await response.json();
	return data.success;
}

export async function unfollowStreamer(streamerId: string): Promise<boolean> {
	const response = await fetch(TL_API.UNFOLLOW, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ streamerId })
	});
	const data = await response.json();
	return data.success;
}

export async function blockStreamer(streamerId: string): Promise<boolean> {
	const response = await fetch(TL_API.BLOCK, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ streamerId })
	});
	const data = await response.json();
	return data.success;
}

export async function fetchMultiBroadcast(streamId: string): Promise<TlStreamer[]> {
	const response = await fetch(TL_API.MULTI_BROADCAST, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ streamId })
	});
	if (!response.ok) return [];
	return await response.json();
}
