import type { Video } from '../types.js';
import { MIN_FILTER_CHARS } from '../constants.js';

export function filterVideos(videos: Video[], filter: string): Video[] {
	if (filter.length < MIN_FILTER_CHARS) return videos;
	try {
		const regex = new RegExp(filter, 'i');
		return videos.filter((v) => regex.test(v.filename));
	} catch {
		return videos;
	}
}
