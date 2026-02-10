import { TL_API } from '../constants.js';

export interface TlStreamer {
	streamerId: string;
	alias: string;
	firstName: string;
	masterListUrl: string;
	isFollowing: boolean;
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
