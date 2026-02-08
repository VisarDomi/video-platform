import { API } from '../constants.js';
import type { Video } from '../types.js';

export async function fetchVideos(provider: string): Promise<Video[]> {
	const url = `${API.VIDEOS}?provider=${encodeURIComponent(provider)}`;
	const response = await fetch(url);
	return await response.json();
}

export async function sendSaveRequest(video: Video, provider: string): Promise<void> {
	await fetch(`${API.EDITED(video.filename)}?provider=${encodeURIComponent(provider)}`, {
		method: 'POST'
	});
}

export async function sendEditRequest(filename: string, segments: string[], provider: string): Promise<void> {
	await fetch(API.EDIT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ filename, segments, provider })
	});
}

export async function sendReturnRequest(video: Video, provider: string): Promise<void> {
	await fetch(`${API.ORIGINAL(video.filename)}?provider=${encodeURIComponent(provider)}`, {
		method: 'POST'
	});
}

export async function sendDeleteRequest(video: Video, provider: string): Promise<void> {
	await fetch(`${API.TRASH(video.filename)}?provider=${encodeURIComponent(provider)}`, {
		method: 'POST'
	});
}
