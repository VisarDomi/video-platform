import { API } from '../constants.js';
import type { Provider } from '../constants.js';
import type { Video } from '../types.js';

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

async function requireOk(response: Response, message: string): Promise<Response> {
	if (!response.ok) throw new ApiError(response.status, `${message}: ${response.statusText}`);
	return response;
}

export async function fetchVideos(
	provider: Provider,
	after?: string,
	signal?: AbortSignal
): Promise<Video[]> {
	const params = new URLSearchParams({ provider });
	if (after) params.set('after', after);
	const response = await requireOk(
		await fetch(`${API.VIDEOS}?${params}`, { signal }),
		'Video fetch failed'
	);
	const items = (await response.json()) as Omit<Video, 'provider'>[];
	return items.map((video) => ({ ...video, provider }));
}

export async function saveVideo(video: Video): Promise<void> {
	await requireOk(
		await fetch(`${API.EDITED(video.filename)}?provider=${encodeURIComponent(video.provider)}`, {
			method: 'POST'
		}),
		'Save failed'
	);
}

export async function editVideo(video: Video, segments: string[]): Promise<void> {
	await requireOk(
		await fetch(API.EDIT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename: video.filename, segments, provider: video.provider })
		}),
		'Edit failed'
	);
}

export async function returnVideo(video: Video): Promise<void> {
	await requireOk(
		await fetch(`${API.ORIGINAL(video.filename)}?provider=${encodeURIComponent(video.provider)}`, {
			method: 'POST'
		}),
		'Return failed'
	);
}
