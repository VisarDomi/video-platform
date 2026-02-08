import { API } from '../constants.js';
import type { Video } from '../types.js';

export async function fetchVideos(provider: string): Promise<Video[]> {
	const url = `${API.VIDEOS}?provider=${encodeURIComponent(provider)}`;
	const response = await fetch(url);
	return await response.json();
}

export async function sendSaveRequest(video: Video, provider: string): Promise<void> {
	const response = await fetch(`${API.EDITED(video.filename)}?provider=${encodeURIComponent(provider)}`, {
		method: 'POST'
	});
	if (!response.ok) throw new Error(`Save failed: ${response.statusText}`);
}

export async function sendEditRequest(filename: string, segments: string[], provider: string): Promise<void> {
	const response = await fetch(API.EDIT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ filename, segments, provider })
	});
	if (!response.ok) throw new Error(`Edit failed: ${response.statusText}`);
}

export async function sendReturnRequest(video: Video, provider: string): Promise<void> {
	const response = await fetch(`${API.ORIGINAL(video.filename)}?provider=${encodeURIComponent(provider)}`, {
		method: 'POST'
	});
	if (!response.ok) throw new Error(`Return failed: ${response.statusText}`);
}

export async function sendDeleteRequest(video: Video, provider: string): Promise<void> {
	const response = await fetch(`${API.TRASH(video.filename)}?provider=${encodeURIComponent(provider)}`, {
		method: 'POST'
	});
	if (!response.ok) throw new Error(`Delete failed: ${response.statusText}`);
}
