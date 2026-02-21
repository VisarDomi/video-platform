import { TL_API } from '../constants.js';

export interface TlStreamer {
	streamerId: string;
	streamId: string;
	alias: string;
	firstName: string;
	masterListUrl: string;
	isFollowing: boolean;
	parentAlias?: string;
	liveUrl?: string;
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

// --- Live URL Resolution ---

export async function resolveLiveUrl(masterListUrl: string): Promise<string | null> {
	try {
		const response = await fetch(TL_API.RESOLVE_LIVE_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ masterPlaylistUrl: masterListUrl })
		});
		if (!response.ok) return null;
		const data = await response.json();
		return data.liveUrl ?? null;
	} catch {
		return null;
	}
}

export async function checkLiveUrl(liveUrl: string): Promise<boolean> {
	try {
		const response = await fetch(TL_API.CHECK_LIVE_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ liveUrl })
		});
		if (!response.ok) return false;
		const data = await response.json();
		return data.alive === true;
	} catch {
		return false;
	}
}

// --- HLS Proxy ---

const proxyUrls = new Map<string, string>();

export async function startProxy(streamer: TlStreamer): Promise<string | undefined> {
	const existing = proxyUrls.get(streamer.alias);
	if (existing) return existing;

	try {
		const response = await fetch(TL_API.PROXY_START, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				masterPlaylistUrl: streamer.masterListUrl,
				alias: streamer.alias
			})
		});
		if (!response.ok) return undefined;
		const data = await response.json();
		const url = data.proxyPlaylistUrl as string;
		proxyUrls.set(streamer.alias, url);
		console.log('[TL:proxy] started:', streamer.alias, url);
		return url;
	} catch (e) {
		console.warn('[TL:proxy] start failed:', streamer.alias, e);
		return undefined;
	}
}

export async function stopProxy(alias: string): Promise<void> {
	proxyUrls.delete(alias);
	try {
		await fetch(TL_API.PROXY_STOP, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ alias })
		});
	} catch {
		// ignore
	}
}

export function getProxyUrl(alias: string): string | undefined {
	return proxyUrls.get(alias);
}

export function syncProxySessions(activeAliases: string[]) {
	const activeSet = new Set(activeAliases);
	for (const alias of proxyUrls.keys()) {
		if (!activeSet.has(alias)) {
			console.log('[TL:proxy] stopping dropped session:', alias);
			void stopProxy(alias);
		}
	}
}
