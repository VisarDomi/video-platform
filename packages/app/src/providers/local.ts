import { API, BPS_ESTIMATE, type LocalProvider } from '../constants.js';
import type { Video } from '../types.js';
import { ApiError, type LocalVideoProvider } from './types.js';

async function requireOk(response: Response, message: string): Promise<Response> {
	if (!response.ok) throw new ApiError(response.status, `${message}: ${response.statusText}`);
	return response;
}

export function localProvider(id: LocalProvider): LocalVideoProvider {
	return {
		id, kind: 'local', estimatedBytesPerSecond: BPS_ESTIMATE,
		videoUrl: video => `/videos/${id}/${encodeURIComponent(video.filename)}?type=${video.type}`,
		async resolvePlayback(video) { return { url: API.HLS_PLAYLIST(id, video.filename), kind: 'hls' }; },
		mediaHint: video => ({ url: API.HLS_PLAYLIST(id, video.filename), kind: 'hls' }),
		async fetchVideos(after, signal) {
			const params = new URLSearchParams({ provider: id });
			if (after) params.set('after', after);
			const response = await requireOk(await fetch(`${API.VIDEOS}?${params}`, { signal }), 'Video fetch failed');
			return ((await response.json()) as Omit<Video, 'provider'>[]).map(video => ({ ...video, provider: id }));
		},
		async save(video) {
			await requireOk(await fetch(`${API.EDITED(video.filename)}?provider=${id}`, { method: 'POST' }), 'Save failed');
		},
		async edit(video, segments) {
			await requireOk(await fetch(API.EDIT, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ filename: video.filename, segments, provider: id })
			}), 'Edit failed');
		},
		async returnOriginal(video) {
			await requireOk(await fetch(`${API.ORIGINAL(video.filename)}?provider=${id}`, { method: 'POST' }), 'Return failed');
		}
	};
}
